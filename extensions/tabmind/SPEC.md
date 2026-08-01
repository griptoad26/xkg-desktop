# XKG Tab Search - Specification

## Project Overview

- **Name:** XKG Tab Search
- **Type:** Chrome/Brave Extension
- **Purpose:** Search content of all open tabs, auto-export Grok conversations to XKG
- **Target:** XKG users with many browser tabs

## Core Features

### 1. Tab Content Search
- Index all open tabs on popup open
- Full-text search across page content
- Relevance ranking
- Keyboard navigation (arrow keys + Enter)
- Click result → jump to tab + highlight match

### 2. Grok Conversation Capture
- Detect x.com/grok tabs
- Auto-export new conversations to XKG
- Push via XKG API endpoint

### 3. XKG Integration
- Configure XKG API endpoint
- Background sync
- Manual export button

## Technical Architecture

```
manifest.json          # Extension manifest (MV3)
├── popup/
│   ├── popup.html     # Search UI
│   ├── popup.js      # Search logic
│   └── styles.css    # Styling
├── background/
│   ├── background.js # Service worker
│   └── grok.js       # Grok detection
├── content/
│   └── content.js   # Page content extraction
└── lib/
    └── flexsearch   # Local search index
```

## API Endpoints (XKG side)

```
POST /api/tab-import    # Import tab content
GET  /api/tabs/status   # Sync status
```

## MVP Scope

### Shipped (v0.7.0)
- [x] Basic tab search
- [x] Content indexing
- [x] Full DOM capture (v0.7.0 — code blocks, headings, images, links,
      tables, lists, blockquotes, summaries)
- [x] Grok tab detection (`x.com/i/grok`, `x.com/grok*`, `grok.com`)
- [x] Auto-export Grok conversations to XKG via `/api/tab-import`
- [x] Settings (XKG endpoint, quick-launch providers)
- [x] Quick-launch LLM row (Grok, ChatGPT, Claude, Gemini, Perplexity,
      Copilot, Meta, Mistral, HuggingChat, You, Phind, Kagi)
- [x] Tab groups by domain / Grok
- [x] GitHub link extraction from indexed pages
- [x] Multiple-tab-suspender support
- [x] Fast indexing (active tab first, rest in background)

### Open items (from griptoad v0.7.0 roadmap)
- [ ] Knowledge graph linker — tag conversations, link related prompts
      (target: v0.8.0, Aug 2026)
- [ ] Multi-device sync — robust conflict resolution + offline queue
      (today: POST JSON to local hub; no CRDT/OT layer)
- [ ] All 4 providers — Claude/ChatGPT/Gemini capture (currently Grok
      only — content script manifest restricted to x.com / grok.com)
- [ ] iOS / macOS runners — CI needs macOS to sign IPAs
- [ ] MSI installer with system-tray autostart reliability
- [ ] WebView2 auto-install fallback (currently bundled)
- [ ] TestFlight / Play Store packaging (today: sideload only)
- [ ] Full docs site (today: README only)

## Install (Brave)

1. `npm install`
2. `npm run build`
3. brave://extensions → Developer Mode → Load unpacked → dist/

### 3. Quick-launch row (NEW 2026-07-23)
Header bar shows one-click buttons that open a **fresh chat tab** in each linked LLM,
mirroring the `x.com/i/grok` pattern (one click, instant fresh conversation).

| Provider | Chat URL | Default |
|---|---|---|
| Grok | `https://x.com/i/grok` | ✓ |
| ChatGPT | `https://chatgpt.com/` | ✓ |
| Claude | `https://claude.ai/new` | ✓ |
| Gemini | `https://gemini.google.com/app` | ✓ |
| Perplexity | `https://www.perplexity.ai/` | ✓ |
| Copilot | `https://copilot.microsoft.com/` | — |
| Meta AI | `https://www.meta.ai/` | — |
| Mistral | `https://chat.mistral.ai/chat` | — |
| HuggingChat | `https://huggingface.co/chat/` | — |
| You.com | `https://you.com/search?q=chat` | — |
| Phind | `https://www.phind.com/` | — |
| Kagi | `https://kagi.com/assistant` | — |

User-selected providers appear in the header. Selection (and order) is configurable from
Settings → "Quick-launch LLM shortcuts". Selections are persisted via
`chrome.storage.local` (key `xkgSettings.quickLaunch`).

#### Implementation notes
- Buttons use `chrome.tabs.create({ url, active: true })` to open in a new tab.
- Each provider gets a brand color via a per-`data-provider` CSS rule.
- Registry lives in `popup.js` (`LLM_REGISTRY` constant) — adding a new provider is
  one object literal + one CSS rule.
- Picker uses an `<input type="checkbox">` grid in Settings; order = left-to-right
  in the header.

