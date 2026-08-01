// =============================================================================
// TabMind - Background Service Worker (v0.8.0)
//
// Responsibilities:
//   1. Auto-detect XKG endpoint on startup
//   2. Cache extracted content per tab in chrome.storage.local (bounded)
//   3. License gating — free users only get Grok; Pro users get all 4
//   4. Forward contentExtracted messages from content scripts to XKG
//   5. Handle popup / content-script messages (getTabContent, setEndpoint,
//      syncGrok, getLicenseStatus, etc.)
//
// v0.8.0 changes:
//   - Provider detection (grok / claude / chatgpt / gemini)
//   - License check (GET /api/license/check with 30-day grace window)
//   - Per-provider gating on auto-send to XKG (only Pro providers flow
//     when tier != 'pro'; free users get grok only)
//   - Caches license response for the grace window (30 days)
// =============================================================================

'use strict';

const DEFAULT_XKG_ENDPOINT = 'http://localhost:18050';
const TAB_CACHE_PREFIX = 'tab-content-';
const MAX_TAB_CACHE_ENTRIES = 200;
const TAB_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MIN_CONTENT_LENGTH = 100;

// License keys
const LICENSE_STORAGE_KEY = 'tabmindLicense';
const DEVICE_ID_STORAGE_KEY = 'tabmindDeviceId';
const LICENSE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days grace

// In-memory only — worker restarts reset this.
let xkgEndpoint = DEFAULT_XKG_ENDPOINT;
let licenseState = { tier: 'free', valid: false, expiresAt: null, cachedAt: 0 };

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

async function detectXkgEndpoint(timeoutMs) {
  timeoutMs = timeoutMs || 2000;
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
  return new Promise(function (resolve) {
    chrome.storage.local.get(['xkgSettings'], function (result) {
      const s = result && result.xkgSettings;
      resolve(s && typeof s.xkgEndpoint === 'string' ? s.xkgEndpoint : null);
    });
  });
}

async function initEndpoint() {
  const stored = await loadStoredEndpoint();
  if (stored) { xkgEndpoint = stored; return; }
  xkgEndpoint = await detectXkgEndpoint();
}

// ---------------------------------------------------------------------------
// Provider detection (single source of truth)
// ---------------------------------------------------------------------------

const PROVIDERS = Object.freeze({
  grok:    { id: 'grok',    tier: 'free', label: 'Grok' },
  claude:  { id: 'claude',  tier: 'pro',  label: 'Claude' },
  chatgpt: { id: 'chatgpt', tier: 'pro',  label: 'ChatGPT' },
  gemini:  { id: 'gemini',  tier: 'pro',  label: 'Gemini' },
  other:   { id: 'other',   tier: 'free', label: 'Other' }
});

function providerFromUrl(url) {
  if (!url) return 'other';
  if (url.includes('x.com/i/grok') || url.includes('x.com/grok') ||
      url.includes('grok.com')) return 'grok';
  if (url.includes('claude.ai') || url.includes('console.anthropic.com')) return 'claude';
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
  if (url.includes('gemini.google.com')) return 'gemini';
  return 'other';
}

// Backward-compat alias for code paths that expect the v0.7.0 boolean
function isGrokUrl(url) { return providerFromUrl(url) === 'grok'; }

// ---------------------------------------------------------------------------
// License gating
// ---------------------------------------------------------------------------

/**
 * Stable device id — UUID stored in chrome.storage.local on first run.
 */
async function getDeviceId() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([DEVICE_ID_STORAGE_KEY], function (result) {
      let id = result && result[DEVICE_ID_STORAGE_KEY];
      if (!id) {
        // Lightweight UUIDv4-ish generator (no crypto module in service worker
        // by default; this is enough for a device fingerprint).
        id = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: id }, function () { resolve(id); });
      } else {
        resolve(id);
      }
    });
  });
}

async function getStoredLicenseKey() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([LICENSE_STORAGE_KEY], function (result) {
      const lic = result && result[LICENSE_STORAGE_KEY];
      resolve(lic && typeof lic.key === 'string' ? lic.key : null);
    });
  });
}

async function loadCachedLicense() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([LICENSE_STORAGE_KEY], function (result) {
      const lic = result && result[LICENSE_STORAGE_KEY];
      if (!lic || !lic.cachedAt) return resolve(null);
      // Expire cached license after grace window
      if (Date.now() - lic.cachedAt > LICENSE_CACHE_TTL_MS) return resolve(null);
      resolve(lic);
    });
  });
}

async function saveCachedLicense(response) {
  return new Promise(function (resolve) {
    const cached = Object.assign({}, response, { cachedAt: Date.now() });
    chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: cached }, function () { resolve(); });
  });
}

/**
 * Determine current effective tier. Order of precedence:
 *   1. Cached license (within grace window)
 *   2. Live /api/license/check if no cache or cache expired
 *   3. Fall back to 'free' (Grok-only)
 *
 * @returns {Promise<{tier: string, valid: boolean, expiresAt: ?string, source: string}>}
 */
async function getEffectiveLicense() {
  // 1. Try cached license
  const cached = await loadCachedLicense();
  if (cached && cached.valid) {
    return {
      tier: cached.tier || 'free',
      valid: true,
      expiresAt: cached.expires_at || null,
      source: 'cache'
    };
  }

  // 2. Live check
  const licenseKey = await getStoredLicenseKey();
  const deviceId = await getDeviceId();
  const resp = await fetchLicense(licenseKey, deviceId, '0.8.0');

  if (resp && resp.valid) {
    await saveCachedLicense(resp);
    return {
      tier: resp.tier || 'free',
      valid: true,
      expiresAt: resp.expires_at || null,
      source: 'live'
    };
  }

  // 3. Fallback: free
  return {
    tier: 'free',
    valid: false,
    expiresAt: null,
    source: 'fallback'
  };
}

async function fetchLicense(licenseKey, deviceId, appVersion) {
  // If no key, return free response directly (no network call needed)
  if (!licenseKey) {
    return { valid: false, tier: 'free' };
  }
  try {
    // Prefer explicit license server URL (overridable via xkgSettings.licenseEndpoint)
    const stored = await new Promise(function (resolve) {
      chrome.storage.local.get(['xkgSettings'], function (r) {
        resolve(r && r.xkgSettings || {});
      });
    });
    const base = (stored && stored.licenseEndpoint) ||
                 ('http://localhost:8765'); // default stub
    const resp = await fetch(base + '/api/license/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: licenseKey,
        device_id: deviceId,
        app_version: appVersion
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return { valid: false, tier: 'free', reason: 'http_' + resp.status };
    const body = await resp.json();
    return {
      valid: !!body.valid,
      tier: body.valid ? (body.tier || 'pro') : 'free',
      expires_at: body.expires_at || null,
      reason: body.reason || null,
      grace_window_days: body.grace_window_days || 30,
      server_time: body.server_time || null
    };
  } catch (e) {
    // Network error → serve cached if any
    console.log('License check network error:', e.message);
    const cached = await loadCachedLicense();
    if (cached && cached.valid) {
      return Object.assign({}, cached, { valid: true });
    }
    return { valid: false, tier: 'free', reason: 'network_error' };
  }
}

/**
 * Returns true if the given provider id is allowed for the current tier.
 * Free tier only allows 'grok'; Pro tier allows all 4.
 */
function isProviderAllowed(providerId, license) {
  if (providerId === 'grok' || providerId === 'other') return true;
  return license && license.tier === 'pro' && license.valid;
}

// ---------------------------------------------------------------------------
// Page-content extraction (fallback when content script unavailable)
// ---------------------------------------------------------------------------

function extractPageContent() {
  const excludeSelectors = [
    'script', 'style', 'noscript', 'iframe',
    'nav', 'header', 'footer', 'aside',
    '.nav', '.menu', '.sidebar', '.ad', '.advertisement',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
  ];

  if (!document.body) {
    return { text: '', blocks: [], aria: { title: '', headings: [], links: [], images: [], landmarks: [] } };
  }

  const clone = document.body.cloneNode(true);
  for (const sel of excludeSelectors) {
    try { clone.querySelectorAll(sel).forEach(function (el) { el.remove(); }); }
    catch (_) { /* invalid selector — ignore */ }
  }

  const text = (clone.body && clone.body.textContent ? clone.body.textContent : '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 50000);

  const blocks = [];
  const MAX_BLOCKS = 500;
  const MAX_BLOCKS_PER_TYPE = 100;
  const MAX_BLOCK_TEXT = 5000;
  const counts = {};
  const addBlock = function (b) {
    if (blocks.length >= MAX_BLOCKS) return;
    const key = b.type;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > MAX_BLOCKS_PER_TYPE) return;
    blocks.push(b);
  };
  const clip = function (s, n) {
    n = n || MAX_BLOCK_TEXT;
    if (!s) return '';
    return s.length > n ? (s.substring(0, n) + '…') : s;
  };

  const targets = document.body.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, p, pre, code, blockquote, ul, ol, img, a, table, hr, summary');
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
          const lt = (li.textContent || '').replace(/\s+/g, ' ').trim();
          if (lt) items.push(clip(lt, 200));
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
      case 'hr': addBlock({ type: 'divider' }); break;
      case 'summary':
        if (t) addBlock({ type: 'summary', text: clip(t) });
        break;
    }
  }

  const aria = {
    title: document.title || '',
    headings: [], links: [], images: [], landmarks: []
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

  return { text: text, blocks: blocks, aria: aria };
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

function cacheKey(tabId) { return TAB_CACHE_PREFIX + tabId; }

async function getCachedContent(tabId) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([cacheKey(tabId)], function (result) {
      const v = result && result[cacheKey(tabId)];
      if (!v || typeof v.content !== 'string') return resolve(null);
      if (v.timestamp && Date.now() - v.timestamp > TAB_CACHE_TTL_MS) {
        chrome.storage.local.remove(cacheKey(tabId));
        return resolve(null);
      }
      resolve(v);
    });
  });
}

async function setCachedContent(tabId, data) {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ [cacheKey(tabId)]: data }, function () { resolve(); });
  }).then(pruneTabCache);
}

async function pruneTabCache() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(null, function (all) {
      if (!all) return resolve();
      const keys = Object.keys(all).filter(function (k) { return k.startsWith(TAB_CACHE_PREFIX); });
      if (keys.length <= MAX_TAB_CACHE_ENTRIES) return resolve();
      const entries = keys
        .map(function (k) { return { k: k, ts: (all[k] && all[k].timestamp) || 0 }; })
        .sort(function (a, b) { return a.ts - b.ts; });
      const toRemove = entries.slice(0, keys.length - MAX_TAB_CACHE_ENTRIES).map(function (e) { return e.k; });
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
        target: { tabId: tabId },
        func: extractPageContent
      });
    } catch (e) {
      console.log('extractPageContent skipped for', tabId, e.message);
      return null;
    }
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
      provider: providerFromUrl(tab.url),
      timestamp: Date.now()
    };
    await setCachedContent(tabId, data);
    return data;
  } catch (e) {
    console.error('getTabContent error:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// XKG sync (with provider / license gating)
// ---------------------------------------------------------------------------

async function sendToXKG(tabId, content, title, url, source, opts) {
  // opts may include: { blocks, aria, captureVersion, provider }
  try {
    const payload = {
      url: url,
      title: title,
      content: content,
      source: source || 'browser',
      timestamp: Date.now()
    };
    if (opts && typeof opts === 'object') {
      if (Array.isArray(opts.blocks) && opts.blocks.length) payload.blocks = opts.blocks;
      if (opts.aria && typeof opts.aria === 'object') payload.aria = opts.aria;
      if (typeof opts.captureVersion === 'number') payload.captureVersion = opts.captureVersion;
      if (typeof opts.provider === 'string') payload.provider = opts.provider;
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

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return false;

  // ----- content script capture (v0.8.0) -------------------------------
  if (message.action === 'contentExtracted') {
    (async function () {
      try {
        const url = message.url || (sender.tab && sender.tab.url) || '';
        const provider = message.provider || providerFromUrl(url);

        // License gating
        const license = await getEffectiveLicense();
        if (!isProviderAllowed(provider, license)) {
          // Free tier blocked: emit an upgrade prompt but don't capture
          sendResponse({
            ok: false,
            blocked: true,
            reason: 'tier_mismatch',
            provider: provider,
            tier: license.tier
          });
          // Optionally notify popup that an upgrade is needed
          try {
            chrome.runtime.sendMessage({
              action: 'licenseBlocked',
              provider: provider,
              tier: license.tier
            }).catch(function () { /* popup not open */ });
          } catch (_) {}
          return;
        }

        // Auto-send to XKG (license-gated above)
        if (message.content && message.content.length >= MIN_CONTENT_LENGTH) {
          await sendToXKG(
            sender.tab ? sender.tab.id : -1,
            message.content,
            message.title || '',
            url,
            provider,
            {
              blocks: message.blocks,
              aria: message.aria,
              captureVersion: message.captureVersion,
              provider: provider
            }
          );
        }

        // Cache under tab id (for popup read)
        if (sender.tab && typeof sender.tab.id === 'number') {
          await setCachedContent(sender.tab.id, {
            content: message.content || '',
            blocks: message.blocks || [],
            aria: message.aria || {},
            title: message.title || '',
            url: url,
            provider: provider,
            timestamp: message.ts || Date.now()
          });
        }

        sendResponse({ ok: true, provider: provider });
      } catch (e) {
        console.error('contentExtracted handler error:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.action === 'getTabContent') {
    getTabContent(message.tabId)
      .then(function (result) {
        if (result) {
          sendResponse({
            text: result.content,
            title: result.title,
            url: result.url,
            provider: result.provider
          });
        } else {
          sendResponse({ text: '', title: '', url: '', provider: 'other' });
        }
      })
      .catch(function (e) {
        console.error('getTabContent msg error:', e);
        sendResponse({ text: '', title: '', url: '', provider: 'other' });
      });
    return true;
  }

  if (message.action === 'syncGrok') {
    syncGrokTabs().then(sendResponse).catch(function (e) {
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

  // ----- v0.8.0 license ------------------------------------------------
  if (message.action === 'getLicenseStatus') {
    getEffectiveLicense().then(function (lic) {
      sendResponse({
        tier: lic.tier,
        valid: lic.valid,
        expiresAt: lic.expiresAt,
        source: lic.source
      });
    });
    return true;
  }

  if (message.action === 'setLicenseKey') {
    (async function () {
      const key = typeof message.key === 'string' ? message.key : '';
      const deviceId = await getDeviceId();
      const lic = await fetchLicense(key, deviceId, '0.8.0');
      if (lic && lic.valid) {
        await saveCachedLicense(Object.assign({ key: key }, lic));
        licenseState = {
          tier: lic.tier || 'pro',
          valid: true,
          expiresAt: lic.expires_at || null,
          cachedAt: Date.now()
        };
        sendResponse({ ok: true, license: lic });
      } else {
        // Cache the failure so popup can show it, but don't replace cache
        sendResponse({ ok: false, license: lic });
      }
    })();
    return true;
  }

  if (message.action === 'providerFromUrl') {
    const url = message.url || '';
    sendResponse({ provider: providerFromUrl(url) });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !tab.url.startsWith('http')) return;

  // Just refresh the cache; content scripts do the actual extraction
  // and call contentExtracted (which is what triggers sendToXKG).
  getTabContent(tabId).catch(function () {});
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  if (!activeInfo || typeof activeInfo.tabId !== 'number') return;
  getTabContent(activeInfo.tabId).catch(function () {});
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.local.remove(cacheKey(tabId), function () {});
});

// ---------------------------------------------------------------------------
// Manual sync (popup-triggered)
// ---------------------------------------------------------------------------

async function syncGrokTabs() {
  const license = await getEffectiveLicense();
  if (!isProviderAllowed('grok', license)) {
    return { ok: false, error: 'license_required', tier: license.tier };
  }
  const tabs = await chrome.tabs.query({});
  const grokTabs = tabs.filter(function (t) { return isGrokUrl(t.url); });
  let synced = 0;
  for (const tab of grokTabs) {
    const cached = await getCachedContent(tab.id);
    if (cached && cached.content && cached.content.length >= MIN_CONTENT_LENGTH) {
      const ok = await sendToXKG(
        tab.id,
        cached.content,
        cached.title,
        cached.url,
        'grok',
        { blocks: cached.blocks, aria: cached.aria, captureVersion: 3, provider: 'grok' }
      );
      if (ok) synced++;
    } else {
      const fresh = await getTabContent(tab.id);
      if (fresh && fresh.content && fresh.content.length >= MIN_CONTENT_LENGTH) {
        const ok = await sendToXKG(
          tab.id,
          fresh.content,
          fresh.title,
          fresh.url,
          'grok',
          { blocks: fresh.blocks, aria: fresh.aria, captureVersion: 3, provider: 'grok' }
        );
        if (ok) synced++;
      }
    }
  }
  return { ok: true, synced: synced, total: grokTabs.length };
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(function () {
  initEndpoint().catch(function (e) { console.error('initEndpoint failed:', e); });
  getEffectiveLicense().then(function (lic) {
    licenseState = { tier: lic.tier, valid: lic.valid, expiresAt: lic.expiresAt, cachedAt: Date.now() };
  });
});

chrome.runtime.onStartup.addListener(function () {
  initEndpoint().catch(function (e) { console.error('initEndpoint failed:', e); });
  getEffectiveLicense().then(function (lic) {
    licenseState = { tier: lic.tier, valid: lic.valid, expiresAt: lic.expiresAt, cachedAt: Date.now() };
  });
});

// Best-effort init on first load
initEndpoint().catch(function (e) { console.error('initEndpoint failed:', e); });
getEffectiveLicense().then(function (lic) {
  licenseState = { tier: lic.tier, valid: lic.valid, expiresAt: lic.expiresAt, cachedAt: Date.now() };
});