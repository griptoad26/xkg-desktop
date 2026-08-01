// =============================================================================
// TabMind - Claude Content Script (v0.8.0)
//
// Runs on:
//   - https://claude.ai/*
//   - https://console.anthropic.com/*
//
// Matches (per manifest.json):
//   - <div data-testid="conversation"> : message turns container
//   - <h2>                             : conversation title
//
// Extracts:
//   - User / assistant turns (data-testid=user-turn / assistant-turn)
//   - Code blocks (pre code)
//   - Tool-use cards (data-testid=tool-use-card)
//
// Falls back to TabMindLib.toBlock for any DOM that doesn't match the
// Claude-specific selectors, so we still produce a useful capture on pages
// in the manifest scope that aren't conversation pages (e.g. project list).
//
// v0.8.0 license gating: returns empty content + sendUpgradePrompt() if the
// user is on the Free tier.
// =============================================================================

(function () {
  'use strict';

  const Lib = window.TabMindLib;
  if (!Lib) {
    console.warn('TabMind claude.js loaded without lib.js — skipping');
    return;
  }

  // -------------------------------------------------------------------------
  // Conversation title
  // -------------------------------------------------------------------------

  /**
   * Conversation title: prefers the page <h1>, falls back to <title>.
   * On Claude.ai the h1 is the conversation title for active conversations.
   */
  function getTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && Lib.normalizeWhitespace(h1.textContent)) {
      return Lib.normalizeWhitespace(h1.textContent).substring(0, 300);
    }
    const h2 = document.querySelector('h2');
    if (h2 && Lib.normalizeWhitespace(h2.textContent)) {
      return Lib.normalizeWhitespace(h2.textContent).substring(0, 300);
    }
    return document.title || '';
  }

  // -------------------------------------------------------------------------
  // Turn extraction (Claude-specific)
  // -------------------------------------------------------------------------

  /**
   * Each message turn is a <div data-testid="user-turn"> or <div
   * data-testid="assistant-turn">. We collect:
   *   - role
   *   - text content (paragraphs + headings)
   *   - code blocks (pre > code)
   *   - tool-use cards
   */
  function extractTurns() {
    const turns = [];
    const turnSelectors = [
      '[data-testid="user-turn"]',
      '[data-testid="assistant-turn"]'
    ];
    for (const sel of turnSelectors) {
      const role = sel.includes('user') ? 'user' : 'assistant';
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const node of nodes) {
        if (Lib.isExcluded(node)) continue;
        const text = Lib.normalizeWhitespace(node.textContent);
        if (!text) continue;

        const turn = {
          role: role,
          text: Lib.clip(text, 8000),
          codeBlocks: [],
          toolUse: []
        };

        // Code blocks
        for (const code of node.querySelectorAll('pre code')) {
          const codeText = (code.textContent || '').trim();
          if (!codeText) continue;
          const lang = Lib.detectCodeLanguage(code, codeText);
          turn.codeBlocks.push({
            lang: lang,
            text: Lib.clip(codeText, 5000)
          });
        }

        // Tool-use cards (Claude's "Artifacts", "Tool use", etc.)
        for (const card of node.querySelectorAll('[data-testid="tool-use-card"], [data-testid="artifact"], .artifact-block, [data-testid="tool_result"]')) {
          const cardText = Lib.normalizeWhitespace(card.textContent);
          if (!cardText) continue;
          const cardTitle = card.querySelector('[data-testid="tool-name"], h3, h4');
          turn.toolUse.push({
            title: cardTitle ? Lib.clip(Lib.normalizeWhitespace(cardTitle.textContent), 100) : '',
            content: Lib.clip(cardText, 3000)
          });
        }

        turns.push(turn);
      }
    }
    return turns;
  }

  // -------------------------------------------------------------------------
  // Top-level extract (called by lifecycle)
  // -------------------------------------------------------------------------

  function extract() {
    const turns = extractTurns();
    const title = getTitle();

    // Plain text: title + each turn's text on its own line
    const textParts = [];
    if (title) textParts.push(title);
    for (const t of turns) {
      if (t.text) textParts.push((t.role === 'user' ? '[User] ' : '[Claude] ') + t.text);
    }
    const text = textParts.join('\n\n').substring(0, 50000);

    // Structured blocks: prefer turn data; fall back to generic DOM walk if no turns
    const blocks = [];
    for (const t of turns) {
      if (t.text) {
        blocks.push({ type: 'paragraph', role: t.role, text: Lib.clip(t.text, 5000) });
      }
      for (const code of t.codeBlocks) {
        blocks.push({ type: 'code', role: t.role, lang: code.lang, text: code.text });
      }
      for (const tool of t.toolUse) {
        blocks.push({ type: 'tool-use', role: t.role, title: tool.title, text: tool.content });
      }
    }

    // If we got nothing from turn selectors (e.g. conversation list page),
    // fall back to the generic DOM walker so we still produce something
    // useful for index/search.
    if (blocks.length === 0 && document.body) {
      const MAX = 200;
      let n = 0;
      for (const el of document.body.querySelectorAll(
        'h1, h2, h3, p, pre, code, blockquote, ul, ol, img, a, table')) {
        if (n >= MAX) break;
        if (Lib.isExcluded(el)) continue;
        const b = Lib.toBlock(el);
        if (b) {
          blocks.push(b);
          n++;
        }
      }
    }

    return {
      text: text,
      blocks: blocks,
      aria: {
        title: title,
        turns: turns.map(function (t) { return { role: t.role, length: t.text.length }; }),
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

  const report = Lib.makeReporter('claude', extract, { minText: 50 });
  Lib.lifecycle(report);
})();