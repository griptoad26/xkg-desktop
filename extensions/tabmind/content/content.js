// =============================================================================
// TabMind - Content Script
//
// Runs on x.com / grok.com pages only (see manifest matches).
// Reports page content to the background script so it can be indexed.
//
// v0.7.0 (2026-07-31): Full DOM capture — extracts code blocks, headings,
//   images, lists, links, and semantic structure, not just text content.
//   Backward compatible: keeps the `content` text field for keyword search;
//   adds a `blocks` array and `aria` summary for richer downstream use
//   (markdown rendering, code-block highlighting, image-aware search).
//
// Production notes:
//   - Single MutationObserver that disconnects on unload
//   - URL-change detection with debounce
//   - Strict selector list (no fuzzy matches)
//   - Sends a content-hash so we can dedupe at the background layer
// =============================================================================

(function () {
  'use strict';

  // Guard: only run on pages we actually care about. Manifest already filters,
  // but be defensive against any unexpected context.
  const HREF = (window.location && window.location.href) || '';
  const isGrokPage =
    HREF.includes('x.com/i/grok') ||
    HREF.includes('x.com/grok?') ||
    HREF.includes('grok.com');

  // Even on non-Grok pages, do nothing — manifest restrict this further
  // but in case the match is widened, we stay conservative.
  if (!isGrokPage) return;

  // -------------------------------------------------------------------------
  // Extraction (v0.7.0 — full DOM capture)
  // -------------------------------------------------------------------------

  const EXCLUDE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe',
    'nav', 'header', 'footer', 'aside',
    '.nav', '.menu', '.sidebar', '.ad', '.advertisement',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
  ];

  // Cap block count to avoid huge payloads on long pages.
  const MAX_BLOCKS = 500;
  const MAX_TEXT_LENGTH = 50000;
  const MAX_BLOCK_TEXT = 5000;
  const MAX_BLOCKS_PER_TYPE = 100;

  /**
   * Extract rich structured content from the page.
   * Returns:
   *   {
   *     text:   string — full plain text for keyword search (legacy field)
   *     blocks: Array<{ type, ... }> — structured blocks (v0.7.0+)
   *     aria:   { title, headings, links, images, landmarks }
   *   }
   */
  function extractContent() {
    if (!document.body) return { text: '', blocks: [], aria: emptyAria() };
    const clone = document.body.cloneNode(true);
    for (const sel of EXCLUDE_SELECTORS) {
      try {
        clone.querySelectorAll(sel).forEach(el => el.remove());
      } catch (_) { /* ignore invalid selectors */ }
    }

    // -- Plain text (legacy, used for search) --
    const text = (clone.body?.textContent || '').replace(/\s+/g, ' ').trim()
      .substring(0, MAX_TEXT_LENGTH);

    // -- Structured blocks (v0.7.0+) --
    const blocks = [];
    const counts = {};
    const addBlock = (b) => {
      if (blocks.length >= MAX_BLOCKS) return;
      const key = b.type;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > MAX_BLOCKS_PER_TYPE) return;
      blocks.push(b);
    };

    // Walk the live DOM (not the clone) so we can compute precise selectors,
    // bounding rects, and source URIs. The clone is only used for plain text.
    const targets = document.body.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, pre, code, blockquote, ul, ol, li, img, a, table, hr, details, summary'
    );
    for (const el of targets) {
      // Skip elements that are inside any excluded subtree
      if (isExcluded(el)) continue;
      const block = toBlock(el);
      if (block) addBlock(block);
    }

    // -- Semantic summary (v0.7.0+) --
    const aria = {
      title: document.title || '',
      headings: collectHeadings(),
      links: collectLinks(),
      images: collectImages(),
      landmarks: collectLandmarks(),
    };

    return { text, blocks, aria };
  }

  function emptyAria() {
    return { title: '', headings: [], links: [], images: [], landmarks: [] };
  }

  function isExcluded(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      if (['script', 'style', 'noscript', 'iframe',
           'nav', 'header', 'footer', 'aside'].includes(tag)) return true;
      const role = (cur.getAttribute && cur.getAttribute('role')) || '';
      if (['navigation', 'banner', 'complementary'].includes(role)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function toBlock(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (!text) return null;
        return { type: 'heading', level: parseInt(tag[1], 10), text: clip(text), rect: slimRect(rect) };
      case 'p':
        if (!text || text.length < 2) return null;
        return { type: 'paragraph', text: clip(text), rect: slimRect(rect) };
      case 'pre':
      case 'code': {
        const code = (el.textContent || '').trim();
        if (!code) return null;
        const lang = detectCodeLanguage(el, code);
        return { type: 'code', lang, text: clip(code, MAX_BLOCK_TEXT), rect: slimRect(rect) };
      }
      case 'blockquote':
        if (!text) return null;
        return { type: 'quote', text: clip(text), rect: slimRect(rect) };
      case 'ul': case 'ol': {
        const items = [];
        for (const li of el.querySelectorAll(':scope > li')) {
          const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) items.push(clip(t, 200));
        }
        if (items.length === 0) return null;
        return { type: 'list', ordered: tag === 'ol', items: items.slice(0, 50), rect: slimRect(rect) };
      }
      case 'li':
        // Already handled by ul/ol block above; skip standalone.
        return null;
      case 'img': {
        const src = el.src || el.getAttribute('data-src') || el.getAttribute('srcset') || '';
        if (!src) return null;
        return { type: 'image', src: src.substring(0, 2000), alt: (el.alt || '').substring(0, 500), rect: slimRect(rect) };
      }
      case 'a': {
        const href = el.href || '';
        if (!href || href.startsWith('javascript:')) return null;
        const linkText = clip(text, 200);
        if (!linkText) return null;
        return { type: 'link', href: href.substring(0, 2000), text: linkText, rect: slimRect(rect) };
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
        if (rows.length === 0) return null;
        return { type: 'table', rows: rows.slice(0, 50), rect: slimRect(rect) };
      }
      case 'hr':
        return { type: 'divider', rect: slimRect(rect) };
      case 'details':
        return null;
      case 'summary':
        if (!text) return null;
        return { type: 'summary', text: clip(text), rect: slimRect(rect) };
      default:
        return null;
    }
  }

  function clip(s, n) {
    n = n || MAX_BLOCK_TEXT;
    if (!s) return '';
    return s.length > n ? (s.substring(0, n) + '…') : s;
  }

  function slimRect(r) {
    if (!r) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function detectCodeLanguage(el, code) {
    // Heuristic: class lists often include "language-xyz"
    const cls = (el.className && String(el.className)) || '';
    const m = cls.match(/language-([a-z0-9+#-]+)/i);
    if (m) return m[1].toLowerCase();
    const parentCls = (el.parentElement && el.parentElement.className) || '';
    const pm = String(parentCls).match(/language-([a-z0-9+#-]+)/i);
    if (pm) return pm[1].toLowerCase();
    // Heuristic content sniff
    if (/^[{[]/.test(code.trim()) && /[}\]]$/.test(code.trim())) return 'json';
    if (/^</.test(code.trim()) && />/.test(code)) return 'xml';
    if (/^(def |class |import |from |print\()/.test(code)) return 'python';
    if (/^(const |let |var |function |=>)/.test(code)) return 'javascript';
    if (/^(SELECT|FROM|WHERE|INSERT)/i.test(code)) return 'sql';
    if (/^#!/.test(code.split('\n')[0])) return 'shell';
    return 'text';
  }

  function collectHeadings() {
    const out = [];
    for (const h of document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      out.push({ level: parseInt(h.tagName[1], 10), text: clip(t, 200) });
      if (out.length >= 50) break;
    }
    return out;
  }

  function collectLinks() {
    const out = [];
    const seen = new Set();
    for (const a of document.body.querySelectorAll('a[href]')) {
      if (isExcluded(a)) continue;
      const href = a.href || '';
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      out.push({ href: href.substring(0, 2000), text: clip(t, 200) });
      if (out.length >= 100) break;
    }
    return out;
  }

  function collectImages() {
    const out = [];
    for (const img of document.body.querySelectorAll('img')) {
      if (isExcluded(img)) continue;
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src) continue;
      out.push({ src: src.substring(0, 2000), alt: (img.alt || '').substring(0, 500) });
      if (out.length >= 50) break;
    }
    return out;
  }

  function collectLandmarks() {
    const out = [];
    for (const el of document.body.querySelectorAll('[role], main, section, article, aside, nav, header, footer')) {
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      if (isExcluded(el)) continue;
      const label = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '').substring(0, 200);
      out.push({ role: role.substring(0, 50), label });
      if (out.length >= 50) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  let lastReportedHash = '';

  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h);
  }

  function reportContent() {
    try {
      const extracted = extractContent();
      if (!extracted.text || extracted.text.length < 100) return;
      const hash = djb2(extracted.text);
      if (hash === lastReportedHash) return; // no change
      lastReportedHash = hash;
      // Shape: legacy `content` (text) PLUS new `blocks` and `aria` for v0.7.0+
      chrome.runtime.sendMessage({
        action: 'contentExtracted',
        url: window.location.href,
        title: document.title,
        content: extracted.text,
        blocks: extracted.blocks,
        aria: extracted.aria,
        isGrok: true,
        contentHash: hash,
        ts: Date.now(),
        captureVersion: 2
      }).catch(() => { /* popup/background not listening — fine */ });
    } catch (e) {
      console.warn('TabMind content report error:', e);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle: load + URL change (debounced)
  // -------------------------------------------------------------------------

  if (document.readyState === 'complete') {
    reportContent();
  } else {
    window.addEventListener('load', reportContent, { once: true });
  }

  let lastUrl = window.location.href;
  let navTimer = null;

  const observer = new MutationObserver(() => {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(reportContent, 1000);
  });

  // Only observe body if it exists at script start
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }, { once: true });
  }

  // Clean up on unload
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    if (navTimer) clearTimeout(navTimer);
  });
})();
