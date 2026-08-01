#!/usr/bin/env node
/**
 * test-suite.cjs — TabMind v0.8.0 test suite
 *
 * Runs in plain Node (no external deps). Uses `vm` to load each content script
 * in a synthetic isolated world with stubs for `window`, `document`, `chrome`,
 * and a minimal DOM tree built by tiny helpers in this file.
 *
 * Tests cover (in this order):
 *   1. TabMindLib shared helpers (djb2, clip, provider detection, etc.)
 *   2. Manifest match patterns / host_permissions
 *   3. Claude extractor — turns, code blocks, tool-use cards
 *   4. ChatGPT extractor — turns, GPTs, tool blocks, DALL-E images
 *   5. Gemini extractor — turns, sidebar, multimodal
 *   6. Grok extractor — full DOM capture (backward-compat)
 *   7. Background provider detection (providerFromUrl)
 *   8. Background license gating (fetchLicense, isProviderAllowed)
 *   9. Background contentExtracted handler (tier mismatch / route)
 *  10. End-to-end: each provider → TabMindLib.getProviderFromUrl
 *
 * Usage:
 *   node test-suite.cjs
 *
 * Exit code 0 on all green, non-zero on failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TABMIND = __dirname;

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];   // pending async tests

function test(name, fn) {
  let p;
  try {
    p = fn();
  } catch (e) {
    fail(name, e);
    return;
  }
  if (p && typeof p.then === 'function') {
    pending.push(p.then(
      function () { pass(name); },
      function (e) { fail(name, e); }
    ));
  } else {
    pass(name);
  }
}

function pass(name) {
  console.log('  \u2713 ' + name);
  results.passed++;
}

function fail(name, e) {
  console.log('  \u2717 ' + name);
  console.log('      ' + (e && e.message ? e.message : String(e)));
  results.failed++;
  results.errors.push({ name: name, error: e });
}

function section(name) {
  console.log('\n=== ' + name + ' ===');
}

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + (msg || 'expected truthy'));
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) +
      (msg ? ' (' + msg + ')' : ''));
  }
}

// ---------------------------------------------------------------------------
// Synthetic DOM
// ---------------------------------------------------------------------------

/**
 * Minimal DOM node. Just enough for extractors to do their job:
 * tagName, getAttribute, textContent, children, querySelectorAll, cloneNode.
 */
class FakeNode {
  constructor(tagName, attrs) {
    this.tagName = (tagName || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this.getBoundingClientRect = function () {
      return { x: 0, y: 0, width: 100, height: 20 };
    };
  }
  set textContent(v) {
    if (this.children.length === 0) {
      this._text = v || '';
    } else {
      const childText = this.children.map(function (c) { return c._text || ''; }).join('');
      this._text = childText + (v || '');
    }
  }
  get textContent() {
    return this._text || '';
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) {
    if (child && child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    this._recomputeText();
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      child.parentNode = null;
      this._recomputeText();
    }
    return child;
  }
  _recomputeText() {
    this._text = this.children.map(function (c) { return c._text || c.textContent || ''; }).join('');
  }
  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) {
    const found = queryAll(this, selector);
    return found.length > 0 ? found[0] : null;
  }
  cloneNode() { return cloneTree(this); }
}

function cloneTree(node) {
  const copy = new FakeNode(node.tagName, Object.assign({}, node.attrs));
  copy._text = node._text;
  for (const c of node.children) {
    copy.appendChild(cloneTree(c));
  }
  return copy;
}

/**
 * Tiny selector matcher. Supports:
 *   tag, tag.class, tag#id, [attr], [attr="value"], tag[attr="value"]
 * Descendant combinators (space) — multi-segment
 * Not supported: comma branches, :scope, pseudo-classes
 */
function parseSelector(sel) {
  const segs = sel.trim().split(/\s+/).filter(Boolean);
  return segs.map(function (s) {
    let tag = '*', id = null, cls = null, attr = null;
    const am = s.match(/^([^\[]+)?(\[([^\]]+)\])(.*)$/);
    if (am) {
      tag = am[1] || '*';
      const inner = am[3];
      const eq = inner.match(/^([a-zA-Z0-9_-]+)\s*=\s*"?([^"]*)"?$/);
      if (eq) attr = { name: eq[1], value: eq[2] };
      else attr = { name: inner, value: null };
    } else {
      const tm = s.match(/^([a-zA-Z0-9_-]+)?(#([a-zA-Z0-9_-]+))?(\.([a-zA-Z0-9_-]+))?$/);
      if (tm) {
        tag = tm[1] || '*';
        id = tm[3] || null;
        cls = tm[5] || null;
      }
    }
    return { tag: tag, id: id, cls: cls, attr: attr, raw: s };
  });
}

function nodeMatches(node, seg) {
  if (seg.tag !== '*' && node.tagName.toLowerCase() !== seg.tag.toLowerCase()) return false;
  if (seg.id && node.attrs.id !== seg.id) return false;
  if (seg.cls) {
    const cls = (node.attrs.class || '').split(/\s+/);
    if (!cls.includes(seg.cls)) return false;
  }
  if (seg.attr) {
    const v = node.attrs[seg.attr.name];
    if (seg.attr.value !== null && v !== seg.attr.value) return false;
    if (seg.attr.value === null && v === undefined) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const segs = parseSelector(selector);
  const out = [];
  function walk(node, segIdx) {
    for (const c of node.children) {
      const seg = segs[segIdx];
      if (nodeMatches(c, seg)) {
        if (segIdx === segs.length - 1) {
          out.push(c);
        } else {
          walk(c, segIdx + 1);
        }
      }
      walk(c, segIdx);
    }
  }
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// World loader
// ---------------------------------------------------------------------------

/**
 * In a vm context, the sandboxed `window` is the global object itself.
 * Content scripts reference `window.location`, `window.TabMindLib`, etc.,
 * so we need `window` to BE the global scope of the vm context.
 *
 * To support multiple providers being loaded into the same vm context
 * (we want one vm context per fixture so that chrome.runtime messages
 * accumulate), we expose everything directly on the global object.
 * Inside content scripts that reference `window.X`, vm will resolve
 * `window` to the global object and find `X`.
 */
function loadScriptIntoWorld(file, world) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInContext(code, world, { filename: file });
  return world;
}

function makeWorld(opts) {
  opts = opts || {};
  const messages = [];
  const url = opts.url || 'https://example.com/';
  const body = opts.body || new FakeNode('body');

  // Build the global object that IS the "window" inside the vm context
  const sandbox = {
    location: { href: url },
    addEventListener: function () {},
    removeEventListener: function () {},
    chrome: {
      runtime: {
        sendMessage: function (msg) {
          messages.push(msg);
          return Promise.resolve();
        },
        onMessage: { addListener: function () {} },
        lastError: null
      },
      storage: {
        local: {
          get: function (_keys, cb) { cb({}); },
          set: function (_obj, cb) { if (cb) cb(); },
          remove: function (_keys, cb) { if (cb) cb(); }
        }
      },
      tabs: {
        query: function (_q, cb) { cb([]); },
        get: function (_id, cb) { cb({}); }
      },
      scripting: {
        executeScript: function (_t, cb) { cb([{ result: null }]); }
      }
    },
    document: {
      body: body,
      title: '',
      readyState: 'complete',
      addEventListener: function () {},
      querySelectorAll: function (sel) { return queryAll(body, sel); },
      querySelector: function (sel) {
        const all = queryAll(body, sel);
        return all.length ? all[0] : null;
      }
    },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    MutationObserver: function () {
      return { observe: function () {}, disconnect: function () {} };
    }
  };

  // Create the vm context once with this sandbox as the global
  vm.createContext(sandbox);

  // Inside content scripts, `window.X` references must resolve to the global.
  // Self-reference so content scripts' `window.location` works.
  sandbox.window = sandbox;

  return { world: sandbox, messages: messages };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaudeConversation() {
  const body = new FakeNode('body');
  const h1 = new FakeNode('h1'); h1.textContent = 'Test Conversation';
  body.appendChild(h1);
  const conv = new FakeNode('div', { 'data-testid': 'conversation' });
  body.appendChild(conv);
  const userTurn = new FakeNode('div', { 'data-testid': 'user-turn' });
  userTurn.textContent = 'Hello Claude';
  conv.appendChild(userTurn);
  const asstTurn = new FakeNode('div', { 'data-testid': 'assistant-turn' });
  conv.appendChild(asstTurn);
  const pre = new FakeNode('pre');
  asstTurn.appendChild(pre);
  const code = new FakeNode('code', { class: 'language-python' });
  code.textContent = 'print("hi")';
  pre.appendChild(code);
  const card = new FakeNode('div', { 'data-testid': 'tool-use-card' });
  asstTurn.appendChild(card);
  const cardTitle = new FakeNode('h3'); cardTitle.textContent = 'Web Search';
  card.appendChild(cardTitle);
  const cardBody = new FakeNode('div'); cardBody.textContent = 'Result: foo bar baz';
  card.appendChild(cardBody);
  return body;
}

function makeChatGPTConversation() {
  const body = new FakeNode('body');
  const userTurn = new FakeNode('div', { 'data-message-author-role': 'user' });
  userTurn.textContent = 'What does \\d+ mean?';
  body.appendChild(userTurn);
  const asstTurn = new FakeNode('div', { 'data-message-author-role': 'assistant' });
  body.appendChild(asstTurn);
  const p = new FakeNode('p'); p.textContent = 'It matches digits';
  asstTurn.appendChild(p);
  const pre = new FakeNode('pre'); asstTurn.appendChild(pre);
  const code = new FakeNode('code'); code.textContent = 'const r = /\\d+/;';
  pre.appendChild(code);
  const img = new FakeNode('img', { src: 'data:image/png;base64,AAAA', alt: 'DALL-E output' });
  asstTurn.appendChild(img);
  const tool = new FakeNode('div', { 'data-message-tool-call': 'web_search' });
  tool.textContent = 'search results';
  asstTurn.appendChild(tool);
  const gptLink = new FakeNode('a', { href: 'https://chatgpt.com/g/g-123' });
  gptLink.textContent = 'My GPT';
  body.appendChild(gptLink);
  return { body: body, title: 'Help with regex' };
}

function makeGeminiConversation() {
  const body = new FakeNode('body');
  const userTurn = new FakeNode('message-content', { 'data-role': 'user' });
  userTurn.textContent = 'List capitals';
  body.appendChild(userTurn);
  const modelTurn = new FakeNode('message-content', { 'data-role': 'model' });
  body.appendChild(modelTurn);
  const txt = new FakeNode('div'); txt.textContent = 'Paris, Berlin, Rome';
  modelTurn.appendChild(txt);
  const pre = new FakeNode('pre'); modelTurn.appendChild(pre);
  const code = new FakeNode('code'); code.textContent = 'print("code execution")';
  pre.appendChild(code);
  const img = new FakeNode('img', { src: 'data:image/png;base64,BBBB', alt: 'generated' });
  modelTurn.appendChild(img);
  const c1 = new FakeNode('a', {
    'data-testid': 'conversation-list-item',
    href: '/app/c-1'
  });
  c1.textContent = 'Yesterday chat';
  body.appendChild(c1);
  const c2 = new FakeNode('a', {
    'data-testid': 'conversation-list-item',
    href: '/app/c-2'
  });
  c2.textContent = 'Last week chat';
  body.appendChild(c2);
  return { body: body, title: 'Capitals of Europe' };
}

function makeGrokPage() {
  const body = new FakeNode('body');
  const h1 = new FakeNode('h1'); h1.textContent = 'Grok chat about AI';
  body.appendChild(h1);
  const p = new FakeNode('p');
  p.textContent = 'Some long enough content to pass minText filter in the Grok extractor. ' +
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  body.appendChild(p);
  const pre = new FakeNode('pre'); body.appendChild(pre);
  const code = new FakeNode('code', { class: 'language-rust' });
  code.textContent = 'fn main() { println!("hi"); }';
  pre.appendChild(code);
  return body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

section('1. TabMindLib shared helpers');

test('lib.js exposes PROVIDERS + getProviderFromUrl', function () {
  const world = makeWorld({ url: 'https://x.com/i/grok', body: new FakeNode('body') }).world;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), world);
  assert(world.TabMindLib, 'TabMindLib should be on window');
  assertEq(typeof world.TabMindLib.getProviderFromUrl, 'function');
  assertEq(world.TabMindLib.getProviderFromUrl('https://x.com/i/grok'), 'grok');
  assertEq(world.TabMindLib.getProviderFromUrl('https://grok.com/'), 'grok');
  assertEq(world.TabMindLib.getProviderFromUrl('https://claude.ai/chat'), 'claude');
  assertEq(world.TabMindLib.getProviderFromUrl('https://console.anthropic.com/'), 'claude');
  assertEq(world.TabMindLib.getProviderFromUrl('https://chatgpt.com/'), 'chatgpt');
  assertEq(world.TabMindLib.getProviderFromUrl('https://chat.openai.com/'), 'chatgpt');
  assertEq(world.TabMindLib.getProviderFromUrl('https://gemini.google.com/app'), 'gemini');
  assertEq(world.TabMindLib.getProviderFromUrl('https://example.com/'), 'other');
  assertEq(world.TabMindLib.getProviderFromUrl(null), 'other');
});

test('djb2 is deterministic', function () {
  const world = makeWorld({ url: 'https://x.com', body: new FakeNode('body') }).world;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), world);
  const a = world.TabMindLib.djb2('hello world');
  const b = world.TabMindLib.djb2('hello world');
  assertEq(a, b, 'same input → same hash');
  const c = world.TabMindLib.djb2('hello world!');
  assert(a !== c, 'different input → different hash');
});

test('clip truncates with ellipsis', function () {
  const world = makeWorld({ url: 'https://x.com', body: new FakeNode('body') }).world;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), world);
  assertEq(world.TabMindLib.clip('hello', 10), 'hello');
  assertEq(world.TabMindLib.clip('abcdefghij', 5), 'abcde\u2026');
  assertEq(world.TabMindLib.clip('', 5), '');
  assertEq(world.TabMindLib.clip(null, 5), '');
});

test('PROVIDERS table has all 4 expected providers with correct tiers', function () {
  const world = makeWorld({ url: 'https://x.com', body: new FakeNode('body') }).world;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), world);
  const P = world.TabMindLib.PROVIDERS;
  assert(P.grok, 'grok should be present');
  assert(P.claude, 'claude should be present');
  assert(P.chatgpt, 'chatgpt should be present');
  assert(P.gemini, 'gemini should be present');
  assertEq(P.grok.tier, 'free');
  assertEq(P.claude.tier, 'pro');
  assertEq(P.chatgpt.tier, 'pro');
  assertEq(P.gemini.tier, 'pro');
});

section('2. Manifest match patterns / host_permissions');

test('manifest.json v0.8.0 with 4 providers in host_permissions', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(TABMIND, 'manifest.json'), 'utf8'));
  assertEq(manifest.version, '0.8.0');
  assertEq(manifest.manifest_version, 3);
  const hp = manifest.host_permissions;
  assert(hp.some(function (p) { return p.includes('x.com'); }), 'x.com host');
  assert(hp.some(function (p) { return p.includes('grok.com'); }), 'grok.com host');
  assert(hp.some(function (p) { return p.includes('claude.ai'); }), 'claude.ai host');
  assert(hp.some(function (p) { return p.includes('console.anthropic.com'); }), 'console.anthropic.com host');
  assert(hp.some(function (p) { return p.includes('chatgpt.com'); }), 'chatgpt.com host');
  assert(hp.some(function (p) { return p.includes('chat.openai.com'); }), 'chat.openai.com host');
  assert(hp.some(function (p) { return p.includes('gemini.google.com'); }), 'gemini.google.com host');
});

test('manifest has 4 separate content_script entries', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(TABMIND, 'manifest.json'), 'utf8'));
  const cs = manifest.content_scripts;
  assert(cs && cs.length >= 4, 'expected >= 4 content_script entries, got ' + (cs && cs.length));
  const matchStr = cs.map(function (c) { return JSON.stringify(c.matches); }).join('|');
  assert(matchStr.includes('claude.ai'));
  assert(matchStr.includes('chatgpt.com'));
  assert(matchStr.includes('gemini.google.com'));
  assert(matchStr.includes('x.com'));
});

test('content scripts point to the right files (and exist)', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(TABMIND, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts.map(function (c) { return c.js[0]; });
  assert(files.includes('content/content.js'), 'content.js for Grok');
  assert(files.includes('content/claude.js'), 'claude.js');
  assert(files.includes('content/chatgpt.js'), 'chatgpt.js');
  assert(files.includes('content/gemini.js'), 'gemini.js');
  files.forEach(function (f) {
    assert(fs.existsSync(path.join(TABMIND, f)), f + ' should exist');
  });
});

section('3. Claude extractor');

test('Claude fixture: user/assistant/code/tool-use shapes correctly', function () {
  const body = makeClaudeConversation();
  const userTurn = body.querySelectorAll('[data-testid="user-turn"]');
  const asstTurn = body.querySelectorAll('[data-testid="assistant-turn"]');
  assertEq(userTurn.length, 1);
  assertEq(asstTurn.length, 1);
  assertEq(userTurn[0].textContent.trim(), 'Hello Claude');
  const codes = asstTurn[0].querySelectorAll('pre code');
  assertEq(codes.length, 1);
  assertEq(codes[0].textContent.trim(), 'print("hi")');
  assertEq(codes[0].attrs.class, 'language-python');
  const cards = asstTurn[0].querySelectorAll('[data-testid="tool-use-card"]');
  assertEq(cards.length, 1);
  const cardTitle = cards[0].querySelectorAll('h3');
  assertEq(cardTitle.length, 1);
  assertEq(cardTitle[0].textContent, 'Web Search');
});

test('Claude extractor sends contentExtracted with provider=claude', function () {
  const body = makeClaudeConversation();
  const w = makeWorld({ url: 'https://claude.ai/chat/123', body: body });
  w.world.document.title = 'Test Conversation';
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), w.world);
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'claude.js'), w.world);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        const msgs = w.messages.filter(function (m) { return m && m.action === 'contentExtracted'; });
        assert(msgs.length >= 1, 'expected >= 1 contentExtracted message');
        const m = msgs[0];
        assertEq(m.provider, 'claude');
        assert(m.content && m.content.includes('Hello Claude'), 'content has user text');
        assert(m.content && m.content.includes('[Claude]'), 'content has assistant marker');
        assert(Array.isArray(m.blocks), 'blocks array');
        const types = m.blocks.map(function (b) { return b.type; });
        assert(types.indexOf('paragraph') !== -1, 'has paragraph');
        assert(types.indexOf('code') !== -1, 'has code');
        assert(types.indexOf('tool-use') !== -1, 'has tool-use');
        assertEq(m.captureVersion, 3);
        resolve();
      } catch (e) { reject(e); }
    }, 400);
  });
});

section('4. ChatGPT extractor');

test('ChatGPT extractor: turns/code/DALL-E/GPTs', function () {
  const fx = makeChatGPTConversation();
  const w = makeWorld({ url: 'https://chatgpt.com/c/abc', body: fx.body });
  w.world.document.title = fx.title;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), w.world);
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'chatgpt.js'), w.world);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        const msgs = w.messages.filter(function (m) { return m && m.action === 'contentExtracted'; });
        assert(msgs.length >= 1);
        const m = msgs[0];
        assertEq(m.provider, 'chatgpt');
        assert(m.content.includes('[user]'), 'has user marker');
        assert(m.content.includes('[assistant]'), 'has assistant marker');
        assert(m.content.includes('It matches digits'));
        const types = m.blocks.map(function (b) { return b.type; });
        assert(types.indexOf('paragraph') !== -1);
        assert(types.indexOf('code') !== -1);
        assert(types.indexOf('image') !== -1, 'has image (DALL-E)');
        assert(types.indexOf('tool-use') !== -1);
        assert(types.indexOf('link') !== -1, 'has GPT link');
        assert(Array.isArray(m.aria.gpts));
        assert(m.aria.gpts.length >= 1);
        assertEq(m.aria.gpts[0].href, 'https://chatgpt.com/g/g-123');
        resolve();
      } catch (e) { reject(e); }
    }, 400);
  });
});

section('5. Gemini extractor');

test('Gemini extractor: turns/code/image/sidebar', function () {
  const fx = makeGeminiConversation();
  const w = makeWorld({ url: 'https://gemini.google.com/app/c-xyz', body: fx.body });
  w.world.document.title = fx.title;
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), w.world);
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'gemini.js'), w.world);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        const msgs = w.messages.filter(function (m) { return m && m.action === 'contentExtracted'; });
        assert(msgs.length >= 1);
        const m = msgs[0];
        assertEq(m.provider, 'gemini');
        assert(m.content.includes('[user]'));
        assert(m.content.includes('[model]'));
        assert(m.content.includes('Paris, Berlin, Rome'));
        const types = m.blocks.map(function (b) { return b.type; });
        assert(types.indexOf('paragraph') !== -1);
        assert(types.indexOf('code') !== -1);
        assert(types.indexOf('image') !== -1);
        assert(types.indexOf('link') !== -1);
        assert(Array.isArray(m.aria.sidebar));
        assert(m.aria.sidebar.length >= 2);
        assertEq(m.aria.sidebar[0].title, 'Yesterday chat');
        resolve();
      } catch (e) { reject(e); }
    }, 400);
  });
});

section('6. Grok extractor (backward compat)');

test('Grok page produces full DOM capture with provider=grok', function () {
  const body = makeGrokPage();
  const w = makeWorld({ url: 'https://x.com/i/grok', body: body });
  w.world.document.title = 'Grok chat about AI';
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), w.world);
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'content.js'), w.world);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        const msgs = w.messages.filter(function (m) { return m && m.action === 'contentExtracted'; });
        assert(msgs.length >= 1);
        const m = msgs[0];
        assertEq(m.provider, 'grok');
        assert(m.content.includes('Grok chat about AI'));
        assert(m.content.includes('Lorem ipsum'));
        const types = m.blocks.map(function (b) { return b.type; });
        assert(types.indexOf('heading') !== -1);
        assert(types.indexOf('paragraph') !== -1);
        assert(types.indexOf('code') !== -1);
        assert(Array.isArray(m.aria.headings));
        assert(m.aria.headings.length >= 1);
        resolve();
      } catch (e) { reject(e); }
    }, 400);
  });
});

test('Grok page guard: non-Grok x.com path sends no messages', function () {
  const body = makeGrokPage();
  const w = makeWorld({ url: 'https://x.com/home', body: body });
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'lib.js'), w.world);
  loadScriptIntoWorld(path.join(TABMIND, 'content', 'content.js'), w.world);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        const msgs = w.messages.filter(function (m) { return m && m.action === 'contentExtracted'; });
        assertEq(msgs.length, 0, 'no messages on non-Grok path');
        resolve();
      } catch (e) { reject(e); }
    }, 300);
  });
});

section('7. Background provider detection');

test('background.js is syntactically valid and exports expected pieces', function () {
  const src = fs.readFileSync(path.join(TABMIND, 'background', 'background.js'), 'utf8');
  new vm.Script(src, { filename: 'background.js' });
  assert(src.includes('function providerFromUrl'), 'providerFromUrl defined');
  assert(src.includes('PROVIDERS = Object.freeze'), 'PROVIDERS table');
  assert(src.includes("'grok'"), 'grok in PROVIDERS');
  assert(src.includes("'claude'"), 'claude in PROVIDERS');
  assert(src.includes("'chatgpt'"), 'chatgpt in PROVIDERS');
  assert(src.includes("'gemini'"), 'gemini in PROVIDERS');
});

test('providerFromUrl logic routes URLs correctly (mirrored in vm world)', function () {
  const code = [
    "const PROVIDERS = { grok:'free', claude:'pro', chatgpt:'pro', gemini:'pro', other:'free' };",
    "function providerFromUrl(url) {",
    "  if (!url) return 'other';",
    "  if (url.includes('x.com/i/grok') || url.includes('x.com/grok') || url.includes('grok.com')) return 'grok';",
    "  if (url.includes('claude.ai') || url.includes('console.anthropic.com')) return 'claude';",
    "  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';",
    "  if (url.includes('gemini.google.com')) return 'gemini';",
    "  return 'other';",
    "}",
    "globalThis.__p = providerFromUrl;",
    "globalThis.__PROVIDERS = PROVIDERS;"
  ].join('\n');
  const ctx = vm.createContext({ globalThis: {} });
  vm.runInContext(code, ctx);
  const p = ctx.globalThis.__p;
  const provs = ctx.globalThis.__PROVIDERS;
  assertEq(p('https://x.com/i/grok'), 'grok');
  assertEq(p('https://x.com/grok/123'), 'grok');
  assertEq(p('https://grok.com/'), 'grok');
  assertEq(p('https://claude.ai/'), 'claude');
  assertEq(p('https://console.anthropic.com/'), 'claude');
  assertEq(p('https://chatgpt.com/c/1'), 'chatgpt');
  assertEq(p('https://chat.openai.com/'), 'chatgpt');
  assertEq(p('https://gemini.google.com/app'), 'gemini');
  assertEq(p('https://example.com/'), 'other');
  assertEq(p(null), 'other');
  assertEq(provs.grok, 'free');
  assertEq(provs.claude, 'pro');
  assertEq(provs.chatgpt, 'pro');
  assertEq(provs.gemini, 'pro');
});

section('8. Background license gating');

test('isProviderAllowed: free tier only allows grok + other', function () {
  const code = [
    "function isProviderAllowed(providerId, license) {",
    "  if (providerId === 'grok' || providerId === 'other') return true;",
    "  return license && license.tier === 'pro' && license.valid;",
    "}",
    "globalThis.__f = isProviderAllowed;"
  ].join('\n');
  const ctx = vm.createContext({ globalThis: {} });
  vm.runInContext(code, ctx);
  const f = ctx.globalThis.__f;
  assertEq(f('grok', { tier: 'free', valid: false }), true);
  assertEq(f('other', { tier: 'free' }), true);
  assertEq(f('claude', { tier: 'free', valid: false }), false);
  assertEq(f('chatgpt', { tier: 'free' }), false);
  assertEq(f('gemini', { tier: 'free' }), false);
  assertEq(f('claude', { tier: 'pro', valid: true }), true);
  assertEq(f('chatgpt', { tier: 'pro', valid: true }), true);
  assertEq(f('gemini', { tier: 'pro', valid: true }), true);
  assertEq(f('claude', { tier: 'pro', valid: false }), false);
});

test('fetchLicense logic handles expired/revoked/free/pro keys', function () {
  const code = [
    "async function fetchLicenseStub(key, serverMock) {",
    "  if (!key) return { valid: false, tier: 'free' };",
    "  const resp = serverMock[key];",
    "  if (!resp) return { valid: false, tier: 'free' };",
    "  if (resp.status !== 200) return { valid: false, tier: 'free', reason: 'http_' + resp.status };",
    "  const body = resp.body;",
    "  return {",
    "    valid: !!body.valid,",
    "    tier: body.valid ? (body.tier || 'pro') : 'free',",
    "    expires_at: body.expires_at || null,",
    "    reason: body.reason || null,",
    "    grace_window_days: body.grace_window_days || 30",
    "  };",
    "}",
    "globalThis.__f = fetchLicenseStub;"
  ].join('\n');
  const ctx = vm.createContext({
    globalThis: {},
    setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise
  });
  vm.runInContext(code, ctx);
  const f = ctx.globalThis.__f;
  const server = {
    'pro-key': { status: 200, body: { valid: true, tier: 'pro', expires_at: '2027-01-01T00:00:00Z' } },
    'expired-key': { status: 200, body: { valid: false, reason: 'expired', expires_at: '2026-01-01T00:00:00Z' } },
    'revoked-key': { status: 200, body: { valid: false, reason: 'revoked', revoked_at: '2026-07-15T00:00:00Z' } },
    'invalid-key': { status: 400, body: { valid: false, reason: 'invalid_key' } }
  };
  return Promise.all([
    f('', server).then(function (r) {
      assertEq(r.valid, false); assertEq(r.tier, 'free');
    }),
    f('pro-key', server).then(function (r) {
      assertEq(r.valid, true);
      assertEq(r.tier, 'pro');
      assertEq(r.expires_at, '2027-01-01T00:00:00Z');
    }),
    f('expired-key', server).then(function (r) {
      assertEq(r.valid, false);
      assertEq(r.reason, 'expired');
    }),
    f('revoked-key', server).then(function (r) {
      assertEq(r.valid, false);
      assertEq(r.reason, 'revoked');
    }),
    f('invalid-key', server).then(function (r) {
      assertEq(r.valid, false);
      assertEq(r.reason, 'http_400');
    })
  ]);
});

test('background.js wires 30-day license grace window', function () {
  const src = fs.readFileSync(path.join(TABMIND, 'background', 'background.js'), 'utf8');
  assert(src.includes('LICENSE_CACHE_TTL_MS'));
  assert(src.includes('1000 * 60 * 60 * 24 * 30'), '30 days in ms');
});

test('contentExtracted handler routes to sendToXKG with provider field', function () {
  const src = fs.readFileSync(path.join(TABMIND, 'background', 'background.js'), 'utf8');
  assert(src.includes("message.action === 'contentExtracted'"), 'handles contentExtracted');
  assert(src.includes('isProviderAllowed(provider, license)'), 'gates on license');
  assert(src.includes('sendToXKG'), 'calls sendToXKG');
  assert(src.includes("payload.provider = opts.provider"), 'forwards provider in payload');
});

section('9. Background contentExtracted tier-mismatch path');

test('contentExtracted returns blocked=true for free user on claude.ai', function () {
  const code = [
    "function isProviderAllowed(providerId, license) {",
    "  if (providerId === 'grok' || providerId === 'other') return true;",
    "  return license && license.tier === 'pro' && license.valid;",
    "}",
    "function handleExtracted(msg, license) {",
    "  const provider = msg.provider;",
    "  if (!isProviderAllowed(provider, license)) {",
    "    return { ok: false, blocked: true, reason: 'tier_mismatch', provider: provider, tier: license.tier };",
    "  }",
    "  return { ok: true, provider: provider };",
    "}",
    "globalThis.__h = handleExtracted;"
  ].join('\n');
  const ctx = vm.createContext({ globalThis: {} });
  vm.runInContext(code, ctx);
  const h = ctx.globalThis.__h;

  const freeResult = h({ provider: 'claude' }, { tier: 'free', valid: false });
  assertEq(freeResult.ok, false);
  assertEq(freeResult.blocked, true);
  assertEq(freeResult.reason, 'tier_mismatch');
  assertEq(freeResult.provider, 'claude');
  assertEq(freeResult.tier, 'free');

  const proResult = h({ provider: 'claude' }, { tier: 'pro', valid: true });
  assertEq(proResult.ok, true);
  assertEq(proResult.provider, 'claude');

  const grokResult = h({ provider: 'grok' }, { tier: 'free', valid: false });
  assertEq(grokResult.ok, true);
  assertEq(grokResult.provider, 'grok');

  const geminiFree = h({ provider: 'gemini' }, { tier: 'free', valid: false });
  assertEq(geminiFree.blocked, true);

  const chatgptPro = h({ provider: 'chatgpt' }, { tier: 'pro', valid: true });
  assertEq(chatgptPro.ok, true);
});

section('10. End-to-end provider routing');

test('URL → provider → tier mapping for all supported URLs', function () {
  const code = [
    "function providerFromUrl(url) {",
    "  if (!url) return 'other';",
    "  if (url.includes('x.com/i/grok') || url.includes('x.com/grok') || url.includes('grok.com')) return 'grok';",
    "  if (url.includes('claude.ai') || url.includes('console.anthropic.com')) return 'claude';",
    "  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';",
    "  if (url.includes('gemini.google.com')) return 'gemini';",
    "  return 'other';",
    "}",
    "const TIERS = { grok:'free', claude:'pro', chatgpt:'pro', gemini:'pro', other:'free' };",
    "globalThis.__route = function(url) { return { provider: providerFromUrl(url), tier: TIERS[providerFromUrl(url)] }; };"
  ].join('\n');
  const ctx = vm.createContext({ globalThis: {} });
  vm.runInContext(code, ctx);
  const r = ctx.globalThis.__route;
  const cases = [
    ['https://x.com/i/grok',           'grok',    'free'],
    ['https://grok.com/',              'grok',    'free'],
    ['https://claude.ai/chat',         'claude',  'pro'],
    ['https://console.anthropic.com/', 'claude',  'pro'],
    ['https://chatgpt.com/c/abc',      'chatgpt', 'pro'],
    ['https://chat.openai.com/',       'chatgpt', 'pro'],
    ['https://gemini.google.com/app',  'gemini',  'pro'],
    ['https://example.com/',           'other',   'free']
  ];
  for (const c of cases) {
    const got = r(c[0]);
    assertEq(got.provider, c[1], 'provider for ' + c[0]);
    assertEq(got.tier, c[2], 'tier for ' + c[0]);
  }
});

// ---------------------------------------------------------------------------
// Wait for all pending async tests, then exit
// ---------------------------------------------------------------------------

Promise.all(pending).then(
  function () {
    console.log('\n----------------------------------------');
    console.log('Results: ' + results.passed + ' passed, ' + results.failed + ' failed');
    if (results.failed > 0) {
      console.log('\nFailed tests:');
      results.errors.forEach(function (e) {
        console.log('  - ' + e.name + ': ' + (e.error && e.error.message ? e.error.message : String(e.error)));
      });
    }
    process.exit(results.failed > 0 ? 1 : 0);
  },
  function (e) {
    console.log('Unexpected error:', e);
    process.exit(1);
  }
);

// Safety net: if tests hang, exit anyway after 10s
setTimeout(function () {
  console.log('\nTimeout: exiting with results so far');
  console.log('Results: ' + results.passed + ' passed, ' + results.failed + ' failed');
  process.exit(results.failed > 0 ? 1 : 0);
}, 10000).unref();