# TabMind — Changelog

## v0.7.0 — Full DOM capture (2026-07-31)

**Core**

- Replaced text-only `extractPageContent` with structured DOM capture.
  Now extracts typed blocks — headings, paragraphs, code, blockquotes,
  lists, images, links, tables, dividers, summaries — not just plain text.
- Added code-language detection (regex on `language-*` class, plus light
  content sniffing for json / python / js / sql / shell).
- Added `aria` summary to every extraction: document title, headings list,
  unique links, images, and semantic landmarks (roles + labels).
- Backward compatible: `content` text field preserved for keyword search;
  `blocks` and `aria` are additive. `sendToXKG` carries the rich data
  through to the XKG server so `/api/tab-import` records full structure.
- Manifest bumped to `0.7.0`.

**Consumers updated**

- `background.getTabContent` now unwraps both string and object results
  (so MV reloads + older caches still work).
- Auto-send of Grok tabs forwards `blocks` and `aria` to XKG.
- `contentExtracted` message handler now receives the rich payload.

**Tests**

- 30/30 existing tests still pass (test-suite.cjs syntax + behavior).
- Manifest + content.js byte-identical to source.

## v0.6.0 — Quick-launch LLM row (2026-07-23)

- One-click buttons in the popup header that open a fresh chat in Grok,
  ChatGPT, Claude, Gemini, Perplexity, and others. Selection persists
  via `chrome.storage.local` (`xkgSettings.quickLaunch`).
- 12-provider registry in `popup.js` (`LLM_REGISTRY`).

## v0.5.0 — Tab groups (2026-07-23)

- Group visible tabs by domain or by Grok tab type.
- Uses Chrome `tabGroups` API; user-selectable in popup.

## v0.4.0 — GitHub link extraction from indexed pages (2026-07-23)

- Detects and surfaces GitHub URLs found in indexed tab content.

## v0.3.x — Indexing reliability (2026-07)

- v0.3.3 More debug logging for `executeScript`
- v0.3.2 Add debug logging to track content extraction
- v0.3.1 Support all major tab suspenders (Great Suspender, Marvellous,
  Reloaded, Tiny, Workona)
- v0.3.0 Fast indexing: show tabs instantly, index active tab first,
  background-index the rest

## v0.2.x — Indexing correctness (2026-07)

- v0.2.1 Skip error pages and incomplete tabs
- v0.2.0 Use background script for content extraction (so the
  content runs in the page world, not the popup world)

## v0.1.x — Initial release

- v0.1.0 Manifest V3 Chrome/Brave extension with popup search.
