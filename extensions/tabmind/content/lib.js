// =============================================================================
// TabMind - Shared Content-Script Library
//
// Helpers used by every per-provider content script (claude.js, chatgpt.js,
// gemini.js, content.js). Exposes:
//
//   - sendCapture(payload)         : chrome.runtime.sendMessage wrapper
//   - djb2(s)                      : stable content hash (matches background)
//   - clip(s, n)                   : string truncation with ellipsis
//   - makeObserver(onChange)       : debounced MutationObserver
//   - lifecycle(reportContent)     : load + URL-change + unload hooks
//   - getProviderFromUrl(url)      : 'claude' | 'chatgpt' | 'gemini' | 'grok' | null
//
// Kept dependency-free so each provider content script can include this with
// a single <script> tag (when MV3 allows) or as a shared module loaded first.
// Content scripts can't use ES modules in MV3 without the "type": "module"
// trick; we use the simple IIFE-on-window approach instead.
// =============================================================================

(function () {
  'use strict';

  // Expose to all same-origin content scripts.
  // Each content script gets its own isolated world in MV3, but `window`
  // is per-isolated-world. We attach helpers to a single namespace so the
  // per-provider scripts can pull from `window.TabMindLib.*`.
  const NS = (window.TabMindLib = window.TabMindLib || {});

  // -------------------------------------------------------------------------
  // Provider detection (single source of truth; background.js mirrors this)
  // -------------------------------------------------------------------------

  NS.PROVIDERS = Object.freeze({
    grok:    { id: 'grok',    tier: 'free', label: 'Grok' },
    claude:  { id: 'claude',  tier: 'pro',  label: 'Claude' },
    chatgpt: { id: 'chatgpt', tier: 'pro',  label: 'ChatGPT' },
    gemini:  { id: 'gemini',  tier: 'pro',  label: 'Gemini' },
    other:   { id: 'other',   tier: 'free', label: 'Other' }
  });

  /**
   * Detect provider from URL. Pure function, no DOM access.
   * Returns the provider id string or 'other' for non-LLM pages.
   */
  NS.getProviderFromUrl = function (url) {
    if (!url) return 'other';
    if (url.includes('x.com/i/grok') || url.includes('x.com/grok') ||
        url.includes('grok.com')) return 'grok';
    if (url.includes('claude.ai') || url.includes('console.anthropic.com')) return 'claude';
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
    if (url.includes('gemini.google.com')) return 'gemini';
    return 'other';
  };

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  NS.djb2 = function (str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return String(h);
  };

  NS.clip = function (s, n) {
    n = n || 5000;
    if (!s) return '';
    return s.length > n ? (s.substring(0, n) + '…') : s;
  };

  NS.normalizeWhitespace = function (s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  };

  // -------------------------------------------------------------------------
  // Capture dispatch
  // -------------------------------------------------------------------------

  NS.sendCapture = function (payload) {
    try {
      chrome.runtime.sendMessage(payload).catch(function () {
        /* background not listening — fine, popup can re-trigger */
      });
    } catch (_) {
      /* chrome.runtime unavailable on this page — silently skip */
    }
  };

  /**
   * Wraps an extraction function and emits contentExtracted messages.
   * `extract()` should return { text, blocks, aria, provider, title } or null.
   */
  NS.makeReporter = function (providerId, extract, opts) {
    opts = opts || {};
    const minText = opts.minText || 50;
    const debounceMs = opts.debounceMs || 800;

    let lastReportedHash = '';

    return function report() {
      try {
        const out = extract();
        if (!out || !out.text || out.text.length < minText) return;
        const hash = NS.djb2(out.text + '|' + (out.title || ''));
        if (hash === lastReportedHash) return;
        lastReportedHash = hash;
        NS.sendCapture({
          action: 'contentExtracted',
          url: window.location.href,
          title: out.title || document.title || '',
          content: out.text,
          blocks: out.blocks || [],
          aria: out.aria || { title: '', headings: [], links: [], images: [], landmarks: [] },
          provider: providerId,
          contentHash: hash,
          ts: Date.now(),
          captureVersion: 3
        });
      } catch (e) {
        console.warn('TabMind ' + providerId + ' report error:', e);
      }
    };
  };

  // -------------------------------------------------------------------------
  // Lifecycle: load + URL-change (debounced) + unload
  // -------------------------------------------------------------------------

  NS.lifecycle = function (reportContent) {
    if (document.readyState === 'complete') {
      // Defer one tick so React/Vue/Svelte hydration finishes
      setTimeout(reportContent, 200);
    } else {
      window.addEventListener('load', function () {
        setTimeout(reportContent, 200);
      }, { once: true });
    }

    let lastUrl = window.location.href;
    let navTimer = null;

    const observer = new MutationObserver(function () {
      if (window.location.href === lastUrl) return;
      lastUrl = window.location.href;
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(reportContent, 1000);
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      }, { once: true });
    }

    window.addEventListener('pagehide', function () {
      observer.disconnect();
      if (navTimer) clearTimeout(navTimer);
    });
  };

  // -------------------------------------------------------------------------
  // DOM-extraction helper (used by non-Grok providers for the rich payload)
  // -------------------------------------------------------------------------

  NS.EXCLUDE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe',
    'nav', 'header', 'footer', 'aside',
    '.nav', '.menu', '.sidebar', '.ad', '.advertisement',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
  ];

  NS.isExcluded = function (el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = (cur.tagName || '').toLowerCase();
      if (['script', 'style', 'noscript', 'iframe',
           'nav', 'header', 'footer', 'aside'].includes(tag)) return true;
      const role = (cur.getAttribute && cur.getAttribute('role')) || '';
      if (['navigation', 'banner', 'complementary'].includes(role)) return true;
      cur = cur.parentNode;
    }
    return false;
  };

  NS.detectCodeLanguage = function (el, code) {
    const cls = (el.className && String(el.className)) || '';
    const m = cls.match(/language-([a-z0-9+#-]+)/i);
    if (m) return m[1].toLowerCase();
    const parentCls = (el.parentElement && el.parentElement.className) || '';
    const pm = String(parentCls).match(/language-([a-z0-9+#-]+)/i);
    if (pm) return pm[1].toLowerCase();
    if (/^[{[]/.test(code.trim()) && /[}\]]$/.test(code.trim())) return 'json';
    if (/^</.test(code.trim()) && />/.test(code)) return 'xml';
    if (/^(def |class |import |from |print\()/.test(code)) return 'python';
    if (/^(const |let |var |function |=>)/.test(code)) return 'javascript';
    if (/^(SELECT|FROM|WHERE|INSERT)/i.test(code)) return 'sql';
    if (/^#!/.test(code.split('\n')[0])) return 'shell';
    return 'text';
  };

  NS.slimRect = function (r) {
    if (!r) return null;
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  };

  NS.toBlock = function (el) {
    const tag = (el.tagName || '').toLowerCase();
    const text = NS.normalizeWhitespace(el.textContent);
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (!text) return null;
        return { type: 'heading', level: parseInt(tag[1], 10),
                 text: NS.clip(text), rect: NS.slimRect(rect) };
      case 'p':
        if (!text || text.length < 2) return null;
        return { type: 'paragraph', text: NS.clip(text), rect: NS.slimRect(rect) };
      case 'pre':
      case 'code': {
        const code = (el.textContent || '').trim();
        if (!code) return null;
        return { type: 'code', lang: NS.detectCodeLanguage(el, code),
                 text: NS.clip(code, 5000), rect: NS.slimRect(rect) };
      }
      case 'blockquote':
        if (!text) return null;
        return { type: 'quote', text: NS.clip(text), rect: NS.slimRect(rect) };
      case 'ul': case 'ol': {
        const items = [];
        for (const li of el.querySelectorAll(':scope > li')) {
          const t = NS.normalizeWhitespace(li.textContent);
          if (t) items.push(NS.clip(t, 200));
        }
        if (items.length === 0) return null;
        return { type: 'list', ordered: tag === 'ol',
                 items: items.slice(0, 50), rect: NS.slimRect(rect) };
      }
      case 'img': {
        const src = el.src || el.getAttribute('data-src') || '';
        if (!src) return null;
        return { type: 'image',
                 src: src.substring(0, 2000),
                 alt: (el.alt || '').substring(0, 500),
                 rect: NS.slimRect(rect) };
      }
      case 'a': {
        const href = el.href || '';
        if (!href || href.startsWith('javascript:')) return null;
        const linkText = NS.clip(text, 200);
        if (!linkText) return null;
        return { type: 'link', href: href.substring(0, 2000),
                 text: linkText, rect: NS.slimRect(rect) };
      }
      case 'table': {
        const rows = [];
        for (const tr of el.querySelectorAll('tr')) {
          const cells = [];
          for (const cell of tr.querySelectorAll('th, td')) {
            const c = NS.normalizeWhitespace(cell.textContent);
            if (c) cells.push(NS.clip(c, 200));
          }
          if (cells.length) rows.push(cells);
          if (rows.length >= 50) break;
        }
        if (rows.length === 0) return null;
        return { type: 'table', rows: rows.slice(0, 50), rect: NS.slimRect(rect) };
      }
      case 'hr':
        return { type: 'divider', rect: NS.slimRect(rect) };
      case 'summary':
        if (!text) return null;
        return { type: 'summary', text: NS.clip(text), rect: NS.slimRect(rect) };
      default:
        return null;
    }
  };
})();