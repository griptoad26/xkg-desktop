// =============================================================================
// TabMind - Gemini Content Script (v0.8.0)
//
// Runs on:
//   - https://gemini.google.com/*
//
// Matches (per manifest.json):
//   - <message-content> : each message turn (user / model)
//   - sidebar conversation list (data-testid="conversation-list-item")
//
// Extracts:
//   - User / model turns
//   - Multimodal responses (images, generated images)
//   - Uploaded images (user uploads)
//   - Code execution outputs
//   - Sidebar conversation list
// =============================================================================

(function () {
  'use strict';

  const Lib = window.TabMindLib;
  if (!Lib) {
    console.warn('TabMind gemini.js loaded without lib.js — skipping');
    return;
  }

  // -------------------------------------------------------------------------
  // Conversation title
  // -------------------------------------------------------------------------

  function getTitle() {
    const t = (document.title || '').trim();
    if (t && t !== 'Gemini' && t !== 'Google Gemini') return t.substring(0, 300);
    const h1 = document.querySelector('h1');
    if (h1) return Lib.normalizeWhitespace(h1.textContent).substring(0, 300);
    return t || '';
  }

  // -------------------------------------------------------------------------
  // Turn extraction (Gemini-specific)
  // -------------------------------------------------------------------------

  function extractTurns() {
    const turns = [];
    let nodes = [];
    try {
      // Gemini renders message turns as custom elements <message-content>
      nodes = document.querySelectorAll('message-content');
    } catch (_) {
      nodes = [];
    }

    for (const node of nodes) {
      if (Lib.isExcluded(node)) continue;
      // The role is typically exposed via a data attribute or sibling marker.
      // We default to 'unknown' and let downstream consumers infer.
      const role = node.getAttribute('data-role') ||
                   node.getAttribute('data-author') ||
                   node.getAttribute('data-message-author-role') ||
                   'unknown';
      const text = Lib.normalizeWhitespace(node.textContent);
      if (!text) continue;

      const turn = {
        role: role,
        text: Lib.clip(text, 8000),
        codeBlocks: [],
        images: []
      };

      // Code blocks (Gemini's code execution responses)
      for (const code of node.querySelectorAll('pre code')) {
        const codeText = (code.textContent || '').trim();
        if (!codeText) continue;
        turn.codeBlocks.push({
          lang: Lib.detectCodeLanguage(code, codeText),
          text: Lib.clip(codeText, 5000)
        });
      }

      // Images: uploaded images (user) + generated images (model)
      for (const img of node.querySelectorAll('img')) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (!src) continue;
        turn.images.push({
          src: src.substring(0, 2000),
          alt: (img.alt || '').substring(0, 500)
        });
      }

      turns.push(turn);
    }
    return turns;
  }

  // -------------------------------------------------------------------------
  // Sidebar conversation list
  // -------------------------------------------------------------------------

  function extractSidebarConversations() {
    const out = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll(
        '[data-testid="conversation-list-item"], ' +
        '.conversation-list-item, ' +
        'a[href*="/app/"]');
    } catch (_) {
      nodes = [];
    }
    for (const node of nodes) {
      if (Lib.isExcluded(node)) continue;
      const text = Lib.normalizeWhitespace(node.textContent);
      const href = (node.getAttribute && node.getAttribute('href')) || '';
      if (!text && !href) continue;
      out.push({
        title: Lib.clip(text || '', 200),
        href: (href || '').substring(0, 2000)
      });
      if (out.length >= 50) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Top-level extract
  // -------------------------------------------------------------------------

  function extract() {
    const turns = extractTurns();
    const title = getTitle();
    const sidebar = extractSidebarConversations();

    const textParts = [];
    if (title) textParts.push(title);
    for (const t of turns) {
      if (t.text) textParts.push('[' + t.role + '] ' + t.text);
    }
    for (const c of sidebar) {
      if (c.title) textParts.push('[Sidebar] ' + c.title);
    }
    const text = textParts.join('\n\n').substring(0, 50000);

    const blocks = [];
    for (const t of turns) {
      if (t.text) blocks.push({ type: 'paragraph', role: t.role, text: Lib.clip(t.text, 5000) });
      for (const code of t.codeBlocks) {
        blocks.push({ type: 'code', role: t.role, lang: code.lang, text: code.text });
      }
      for (const img of t.images) {
        blocks.push({ type: 'image', role: t.role, src: img.src, alt: img.alt });
      }
    }
    for (const c of sidebar) {
      blocks.push({ type: 'link', href: c.href, text: c.title });
    }

    // Fallback for non-conversation pages (landing, settings, etc.)
    if (blocks.length === 0 && document.body) {
      let n = 0;
      for (const el of document.body.querySelectorAll(
        'h1, h2, h3, p, pre, code, blockquote, ul, ol, img, a, table')) {
        if (n >= 200) break;
        if (Lib.isExcluded(el)) continue;
        const b = Lib.toBlock(el);
        if (b) { blocks.push(b); n++; }
      }
    }

    return {
      text: text,
      blocks: blocks,
      aria: {
        title: title,
        turns: turns.map(function (t) { return { role: t.role, length: t.text.length }; }),
        sidebar: sidebar,
        headings: collectHeadings(),
        links: collectLinks(),
        images: collectImages(),
        landmarks: []
      }
    };
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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const report = Lib.makeReporter('gemini', extract, { minText: 50 });
  Lib.lifecycle(report);
})();