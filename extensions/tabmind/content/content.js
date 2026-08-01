// =============================================================================
// TabMind - Grok Content Script (v0.8.0 — refactored to use TabMindLib)
//
// Runs on:
//   - https://x.com/* (with grok-specific paths)
//   - https://grok.com/*
//
// Preserves v0.7.0 full-DOM capture behavior. Adds `provider: 'grok'` to
// outgoing messages so background can route correctly.
//
// v0.8.0 changes:
//   - All extraction helpers moved to TabMindLib (see content/lib.js)
//   - this script only declares Grok-specific extraction
//   - lifecycle, hashing, dispatching handled by Lib.makeReporter + Lib.lifecycle
// =============================================================================

(function () {
  'use strict';

  const Lib = window.TabMindLib;
  if (!Lib) {
    console.warn('TabMind content.js loaded without lib.js — skipping');
    return;
  }

  // -------------------------------------------------------------------------
  // Page-type guard
  // -------------------------------------------------------------------------

  const HREF = (window.location && window.location.href) || '';
  const isGrokPage =
    HREF.includes('x.com/i/grok') ||
    HREF.includes('x.com/grok') ||
    HREF.includes('grok.com');

  if (!isGrokPage) return;

  // -------------------------------------------------------------------------
  // Extraction (full DOM capture; preserves v0.7.0 behavior)
  // -------------------------------------------------------------------------

  const MAX_BLOCKS = 500;
  const MAX_BLOCKS_PER_TYPE = 100;
  const MAX_TEXT_LENGTH = 50000;

  function extract() {
    if (!document.body) {
      return { text: '', blocks: [], aria: emptyAria() };
    }

    // Plain text for keyword search (legacy field)
    const clone = document.body.cloneNode(true);
    for (const sel of Lib.EXCLUDE_SELECTORS) {
      try { clone.querySelectorAll(sel).forEach(function (el) { el.remove(); }); }
      catch (_) { /* invalid selector — ignore */ }
    }
    const text = (clone.body && clone.body.textContent ? clone.body.textContent : '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, MAX_TEXT_LENGTH);

    // Structured blocks
    const blocks = [];
    const counts = {};
    const addBlock = function (b) {
      if (blocks.length >= MAX_BLOCKS) return;
      const key = b.type;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > MAX_BLOCKS_PER_TYPE) return;
      blocks.push(b);
    };

    const targets = document.body.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, pre, code, blockquote, ul, ol, li, img, a, table, hr, details, summary');
    for (const el of targets) {
      if (Lib.isExcluded(el)) continue;
      const block = Lib.toBlock(el);
      if (block) addBlock(block);
    }

    return {
      text: text,
      blocks: blocks,
      aria: {
        title: document.title || '',
        headings: collectHeadings(),
        links: collectLinks(),
        images: collectImages(),
        landmarks: collectLandmarks()
      }
    };
  }

  function emptyAria() {
    return { title: '', headings: [], links: [], images: [], landmarks: [] };
  }

  function collectHeadings() {
    const out = [];
    for (const h of document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const t = Lib.normalizeWhitespace(h.textContent);
      if (!t) continue;
      out.push({ level: parseInt(h.tagName[1], 10), text: Lib.clip(t, 200) });
      if (out.length >= 50) break;
    }
    return out;
  }

  function collectLinks() {
    const out = [];
    const seen = new Set();
    for (const a of document.body.querySelectorAll('a[href]')) {
      if (Lib.isExcluded(a)) continue;
      const href = a.href || '';
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const t = Lib.normalizeWhitespace(a.textContent);
      if (!t) continue;
      out.push({ href: href.substring(0, 2000), text: Lib.clip(t, 200) });
      if (out.length >= 100) break;
    }
    return out;
  }

  function collectImages() {
    const out = [];
    for (const img of document.body.querySelectorAll('img')) {
      if (Lib.isExcluded(img)) continue;
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src) continue;
      out.push({ src: src.substring(0, 2000), alt: (img.alt || '').substring(0, 500) });
      if (out.length >= 50) break;
    }
    return out;
  }

  function collectLandmarks() {
    const out = [];
    for (const el of document.body.querySelectorAll(
      '[role], main, section, article, aside, nav, header, footer')) {
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      if (Lib.isExcluded(el)) continue;
      const label = (el.getAttribute('aria-label') ||
                     el.getAttribute('aria-labelledby') || '').substring(0, 200);
      out.push({ role: role.substring(0, 50), label: label });
      if (out.length >= 50) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const report = Lib.makeReporter('grok', extract, { minText: 100 });
  Lib.lifecycle(report);
})();