// =============================================================================
// TabMind - Background Service Worker
//
// Responsibilities:
//   1. Auto-detect XKG endpoint on startup
//   2. Extract page content via chrome.scripting when tabs load/change
//   3. Cache extracted content in chrome.storage.local (bounded)
//   4. Send content to XKG on demand
//   5. Handle messages from popup and content scripts
//
// Production notes:
//   - No top-level await / side effects beyond the API registration
//   - All fetches have try/catch + timeouts
//   - cache entries are pruned on a size cap
//   - auto-send is gated (only Grok pages, or explicit request)
// =============================================================================

'use strict';

const DEFAULT_XKG_ENDPOINT = 'http://localhost:18050';
const TAB_CACHE_PREFIX = 'tab-content-';
const MAX_TAB_CACHE_ENTRIES = 200;       // hard cap
const TAB_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MIN_CONTENT_LENGTH = 100;

// In-memory only — worker restarts reset this, that's fine.
// Persisted endpoint lives in chrome.storage.local (key: xkgSettings.xkgEndpoint).
let xkgEndpoint = DEFAULT_XKG_ENDPOINT;

// ---------------------------------------------------------------------------
// XKG endpoint detection
// ---------------------------------------------------------------------------

const XKG_ENDPOINT_CANDIDATES = [
  { url: 'http://localhost:18050',     platform: 'desktop' },
  { url: 'http://10.0.2.2:18050',      platform: 'android-emulator' },
  { url: 'http://localhost:18050',     platform: 'ios-simulator' },
  { url: 'http://192.168.50.187:18050', platform: 'android-device' },
  { url: 'http://localhost:8080',      platform: 'web-alt' },
  { url: 'http://localhost:5000',      platform: 'legacy' }
];

async function detectXkgEndpoint(timeoutMs = 2000) {
  for (const ep of XKG_ENDPOINT_CANDIDATES) {
    try {
      const resp = await fetch(ep.url + '/api/health', {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (resp.ok) {
        console.log('XKG found at:', ep.url, '(', ep.platform, ')');
        return ep.url;
      }
    } catch (_) { /* try next */ }
  }
  console.log('XKG not detected, using default:', DEFAULT_XKG_ENDPOINT);
  return DEFAULT_XKG_ENDPOINT;
}

async function loadStoredEndpoint() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['xkgSettings'], (result) => {
      const s = result && result.xkgSettings;
      resolve(s && typeof s.xkgEndpoint === 'string' ? s.xkgEndpoint : null);
    });
  });
}

async function initEndpoint() {
  // 1. Persisted user setting wins
  const stored = await loadStoredEndpoint();
  if (stored) {
    xkgEndpoint = stored;
    return;
  }
  // 2. Auto-detect
  const found = await detectXkgEndpoint();
  xkgEndpoint = found;
}

// ---------------------------------------------------------------------------
// Grok detection (must match popup's logic)
// ---------------------------------------------------------------------------

function isGrokUrl(url) {
  if (!url) return false;
  return (
    url.includes('x.com/grok') ||
    url.includes('x.com/i/grok') ||
    url.includes('grok.com') ||
    url.includes('x.com/grokai')
  );
}

// ---------------------------------------------------------------------------
// Page-content extraction (runs in the page's world via executeScript)
// ---------------------------------------------------------------------------

// Same extraction logic as content/content.js — kept in sync so both
// code paths (passive content script + active executeScript) return
// the same rich structure. v0.7.0: full DOM capture.
function extractPageContent() {
  const excludeSelectors = [
    'script', 'style', 'noscript', 'iframe',
    'nav', 'header', 'footer', 'aside',
    '.nav', '.menu', '.sidebar', '.ad', '.advertisement',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
  ];

  if (!document.body) return { text: '', blocks: [], aria: { title: '', headings: [], links: [], images: [], landmarks: [] } };

  const clone = document.body.cloneNode(true);
  for (const sel of excludeSelectors) {
    try {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    } catch (_) { /* invalid selector — ignore */ }
  }

  const text = (clone.body?.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50000);

  // Structured blocks (v0.7.0+) — keep extraction cheap here; full version
  // lives in content/content.js. This variant is the fallback when the
  // content script is unavailable (e.g. non-Grok page being indexed on
  // demand via the popup).
  const blocks = [];
  const MAX_BLOCKS = 500;
  const MAX_BLOCKS_PER_TYPE = 100;
  const MAX_BLOCK_TEXT = 5000;
  const counts = {};
  const addBlock = (b) => {
    if (blocks.length >= MAX_BLOCKS) return;
    const key = b.type;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > MAX_BLOCKS_PER_TYPE) return;
    blocks.push(b);
  };
  const clip = (s, n) => {
    n = n || MAX_BLOCK_TEXT;
    if (!s) return '';
    return s.length > n ? (s.substring(0, n) + '…') : s;
  };
  const targets = document.body.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, p, pre, code, blockquote, ul, ol, img, a, table, hr, summary'
  );
  for (const el of targets) {
    const tag = el.tagName.toLowerCase();
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (t) addBlock({ type: 'heading', level: parseInt(tag[1], 10), text: clip(t) });
        break;
      case 'p':
        if (t && t.length >= 2) addBlock({ type: 'paragraph', text: clip(t) });
        break;
      case 'pre': case 'code': {
        const code = (el.textContent || '').trim();
        if (code) addBlock({ type: 'code', lang: 'text', text: clip(code, MAX_BLOCK_TEXT) });
        break;
      }
      case 'blockquote':
        if (t) addBlock({ type: 'quote', text: clip(t) });
        break;
      case 'ul': case 'ol': {
        const items = [];
        for (const li of el.querySelectorAll(':scope > li')) {
          const li_t = (li.textContent || '').replace(/\s+/g, ' ').trim();
          if (li_t) items.push(clip(li_t, 200));
        }
        if (items.length) addBlock({ type: 'list', ordered: tag === 'ol', items: items.slice(0, 50) });
        break;
      }
      case 'img': {
        const src = el.src || el.getAttribute('data-src') || '';
        if (src) addBlock({ type: 'image', src: src.substring(0, 2000), alt: (el.alt || '').substring(0, 500) });
        break;
      }
      case 'a': {
        const href = el.href || '';
        if (href && !href.startsWith('javascript:') && t) addBlock({ type: 'link', href: href.substring(0, 2000), text: clip(t, 200) });
        break;
      }
      case 'table': {
        const rows = [];
        for (const tr of el.querySelectorAll('tr')) {
          const cells = [];
          for (const cell of tr.querySelectorAll('th, td')) {
            const c = (cell.textContent || '').replace(/\s+/g, ' ').trim();
            if (c) cells.push(clip(c, 200));
          }
          if (cells.length) rows.push(cells);
          if (rows.length >= 50) break;
        }
        if (rows.length) addBlock({ type: 'table', rows: rows.slice(0, 50) });
        break;
      }
      case 'hr':
        addBlock({ type: 'divider' });
        break;
      case 'summary':
        if (t) addBlock({ type: 'summary', text: clip(t) });
        break;
    }
  }

  const aria = {
    title: document.title || '',
    headings: [],
    links: [],
    images: [],
    landmarks: [],
  };
  for (const h of document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const ht = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (ht) aria.headings.push({ level: parseInt(h.tagName[1], 10), text: clip(ht, 200) });
    if (aria.headings.length >= 50) break;
  }
  const seenLinks = new Set();
  for (const a of document.body.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
    if (seenLinks.has(href)) continue;
    seenLinks.add(href);
    const lt = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!lt) continue;
    aria.links.push({ href: href.substring(0, 2000), text: clip(lt, 200) });
    if (aria.links.length >= 100) break;
  }
  for (const img of document.body.querySelectorAll('img')) {
    const src = img.src || img.getAttribute('data-src') || '';
    if (!src) continue;
    aria.images.push({ src: src.substring(0, 2000), alt: (img.alt || '').substring(0, 500) });
    if (aria.images.length >= 50) break;
  }

  return { text, blocks, aria };
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

function cacheKey(tabId) { return TAB_CACHE_PREFIX + tabId; }

async function getCachedContent(tabId) {
  return new Promise((resolve) => {
    chrome.storage.local.get([cacheKey(tabId)], (result) => {
      const v = result && result[cacheKey(tabId)];
      if (!v || typeof v.content !== 'string') return resolve(null);
      // Expire stale
      if (v.timestamp && Date.now() - v.timestamp > TAB_CACHE_TTL_MS) {
        chrome.storage.local.remove(cacheKey(tabId));
        return resolve(null);
      }
      resolve(v);
    });
  });
}

async function setCachedContent(tabId, data) {
  await new Promise((resolve) => {
    chrome.storage.local.set({ [cacheKey(tabId)]: data }, resolve);
  });
  await pruneTabCache();
}

async function pruneTabCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      if (!all) return resolve();
      const keys = Object.keys(all).filter(k => k.startsWith(TAB_CACHE_PREFIX));
      if (keys.length <= MAX_TAB_CACHE_ENTRIES) return resolve();
      // Evict oldest
      const entries = keys
        .map(k => ({ k, ts: (all[k] && all[k].timestamp) || 0 }))
        .sort((a, b) => a.ts - b.ts);
      const toRemove = entries.slice(0, keys.length - MAX_TAB_CACHE_ENTRIES).map(e => e.k);
      chrome.storage.local.remove(toRemove, resolve);
    });
  });
}

// ---------------------------------------------------------------------------
// Tab content extraction
// ---------------------------------------------------------------------------

async function getTabContent(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return null;

    if (
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('brave://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:') ||
      tab.url.startsWith('chrome-search://')
    ) {
      return null;
    }
    if (tab.status !== 'complete' || tab.discarded) return null;

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageContent
      });
    } catch (e) {
      // Scripting may fail on chrome:// pages or sandboxed iframes
      console.log('extractPageContent skipped for', tabId, e.message);
      return null;
    }
    // Backward compatible: result is now { text, blocks, aria } from v0.7.0+.
    // Older providers may still return plain strings — handle both.
    const raw = (results && results[0] && results[0].result);
    const extracted = (raw && typeof raw === 'object')
      ? raw
      : { text: typeof raw === 'string' ? raw : '', blocks: [], aria: {} };
    const text = extracted.text || '';
    if (!text || text.length <= 10) return null;

    const data = {
      content: text,
      blocks: extracted.blocks || [],
      aria: extracted.aria || {},
      title: tab.title || '',
      url: tab.url,
      timestamp: Date.now(),
    };
    await setCachedContent(tabId, data);
    return data;
  } catch (e) {
    console.error('getTabContent error:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// XKG sync
// ---------------------------------------------------------------------------

async function sendToXKG(tabId, content, title, url, source, opts) {
  // opts may include: { blocks, aria, captureVersion }
  // Backward compatible with old call sites that pass only 5 args.
  try {
    const payload = {
      url,
      title,
      content,
      source: source || 'browser',
      timestamp: Date.now()
    };
    if (opts && typeof opts === 'object') {
      if (Array.isArray(opts.blocks) && opts.blocks.length) payload.blocks = opts.blocks;
      if (opts.aria && typeof opts.aria === 'object') payload.aria = opts.aria;
      if (typeof opts.captureVersion === 'number') payload.captureVersion = opts.captureVersion;
    }
    const resp = await fetch(xkgEndpoint + '/api/tab-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      console.log('TabMind: Sent to XKG:', (url || '').substring(0, 60));
      return true;
    }
    console.warn('XKG send non-OK:', resp.status);
    return false;
  } catch (e) {
    console.log('TabMind: Failed to send to XKG:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.action === 'getTabContent') {
    getTabContent(message.tabId)
      .then((result) => {
        if (result) {
          sendResponse({ text: result.content, title: result.title, url: result.url });
        } else {
          sendResponse({ text: '', title: '', url: '' });
        }
      })
      .catch((e) => {
        console.error('getTabContent msg error:', e);
        sendResponse({ text: '', title: '', url: '' });
      });
    return true; // async response
  }

  if (message.action === 'syncGrok') {
    syncGrokTabs().then(sendResponse).catch((e) => {
      console.error('syncGrok msg error:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (message.action === 'setEndpoint') {
    if (typeof message.endpoint === 'string') {
      xkgEndpoint = message.endpoint;
    }
    sendResponse({ success: true, endpoint: xkgEndpoint });
    return false;
  }

  if (message.action === 'getEndpoint') {
    sendResponse({ endpoint: xkgEndpoint });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !tab.url.startsWith('http')) return;

  getTabContent(tabId).then((result) => {
    if (!result || !result.content || result.content.length < MIN_CONTENT_LENGTH) return;
    // Only auto-send Grok pages. Don't blast every article to XKG.
    if (isGrokUrl(tab.url)) {
      sendToXKG(tabId, result.content, result.title, result.url, 'grok', {
        blocks: result.blocks,
        aria: result.aria
      });
    }
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== 'number') return;
  getTabContent(activeInfo.tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(cacheKey(tabId), () => {});
});

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  initEndpoint().catch(e => console.error('initEndpoint failed:', e));
});

chrome.runtime.onStartup.addListener(() => {
  initEndpoint().catch(e => console.error('initEndpoint failed:', e));
});

// Best-effort init on first load (covers worker reload without install)
initEndpoint().catch(e => console.error('initEndpoint failed:', e));
