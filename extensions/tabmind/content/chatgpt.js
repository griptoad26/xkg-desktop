// =============================================================================
// TabMind - ChatGPT Content Script (v0.8.0)
//
// Runs on:
//   - https://chatgpt.com/*
//   - https://chat.openai.com/*
//
// Matches (per manifest.json):
//   - [data-message-author-role] : each message turn (user / assistant / tool / system)
//   - <title>                     : conversation title
//
// Extracts:
//   - User / assistant turns
//   - GPT references (links to gpts)
//   - Tool blocks (code interpreter, web search, image gen)
//   - DALL-E generated images
//   - Code interpreter outputs
// =============================================================================

(function () {
  'use strict';

  const Lib = window.TabMindLib;
  if (!Lib) {
    console.warn('TabMind chatgpt.js loaded without lib.js — skipping');
    return;
  }

  // -------------------------------------------------------------------------
  // Conversation title
  // -------------------------------------------------------------------------

  function getTitle() {
    // ChatGPT sets document.title to the conversation title once loaded
    const t = (document.title || '').trim();
    if (t && t !== 'New chat' && t !== 'ChatGPT') return t.substring(0, 300);
    // Fallback: the sidebar may expose a heading
    const h1 = document.querySelector('h1');
    if (h1) return Lib.normalizeWhitespace(h1.textContent).substring(0, 300);
    return t || '';
  }

  // -------------------------------------------------------------------------
  // Turn extraction (ChatGPT-specific)
  // -------------------------------------------------------------------------

  function extractTurns() {
    const turns = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll('[data-message-author-role]');
    } catch (_) { return turns; }

    for (const node of nodes) {
      if (Lib.isExcluded(node)) continue;
      const role = node.getAttribute('data-message-author-role') || 'unknown';
      const text = Lib.normalizeWhitespace(node.textContent);
      if (!text) continue;

      const turn = {
        role: role,
        text: Lib.clip(text, 8000),
        codeBlocks: [],
        images: [],
        tools: []
      };

      // Code blocks
      for (const code of node.querySelectorAll('pre code')) {
        const codeText = (code.textContent || '').trim();
        if (!codeText) continue;
        turn.codeBlocks.push({
          lang: Lib.detectCodeLanguage(code, codeText),
          text: Lib.clip(codeText, 5000)
        });
      }

      // DALL-E generated images
      for (const img of node.querySelectorAll('img')) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (!src) continue;
        // Heuristic: DALL-E output typically lives inside the assistant turn
        // and has srcset with multiple sizes; keep all for now.
        turn.images.push({
          src: src.substring(0, 2000),
          alt: (img.alt || '').substring(0, 500)
        });
      }

      // Tool blocks: code interpreter, web search results, image gen output
      for (const tool of node.querySelectorAll('[data-message-tool-call], .result-stuff, .code-interpreter-output, [data-testid="code-interpreter-result"]')) {
        const toolText = Lib.normalizeWhitespace(tool.textContent);
        if (!toolText) continue;
        turn.tools.push({
          kind: tool.getAttribute('data-message-tool-call') || 'tool',
          text: Lib.clip(toolText, 3000)
        });
      }

      turns.push(turn);
    }
    return turns;
  }

  // -------------------------------------------------------------------------
  // GPT references (sidebar / "Made with GPTs")
  // -------------------------------------------------------------------------

  function extractGptRefs() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/gpts/"], a[href*="/g/"]')) {
      const href = a.href;
      if (!href) continue;
      out.push({
        href: href.substring(0, 2000),
        text: Lib.clip(Lib.normalizeWhitespace(a.textContent), 200)
      });
      if (out.length >= 20) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Top-level extract
  // -------------------------------------------------------------------------

  function extract() {
    const turns = extractTurns();
    const title = getTitle();
    const gptRefs = extractGptRefs();

    const textParts = [];
    if (title) textParts.push(title);
    for (const t of turns) {
      if (t.text) textParts.push('[' + t.role + '] ' + t.text);
    }
    for (const g of gptRefs) {
      textParts.push('[GPT] ' + g.text + ' ' + g.href);
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
      for (const tool of t.tools) {
        blocks.push({ type: 'tool-use', role: t.role, kind: tool.kind, text: tool.text });
      }
    }
    for (const g of gptRefs) {
      blocks.push({ type: 'link', href: g.href, text: g.text });
    }

    // Fallback for non-conversation pages (model picker, settings, etc.)
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
        gpts: gptRefs,
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

  const report = Lib.makeReporter('chatgpt', extract, { minText: 50 });
  Lib.lifecycle(report);
})();