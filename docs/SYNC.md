# Cross-Device Sync Architecture

XKG Desktop, cluster-hub, and XKG Mobile work together to give you the same knowledge base on every device.

## Components

| Component | Role | Platform |
|-----------|------|----------|
| **XKG Desktop** | Captures text via global shortcut, has full local SQLite | Linux, Windows, macOS |
| **cluster-hub** | Central sync broker, REST API, JSONL bridge | Server (Python) |
| **XKG Mobile** | Reads captures from JSONL, displays AI chat launcher | Android, Linux, Windows |

## Sync Flow

```
┌────────────────────────────────────────────────────────────────┐
│ 1. CAPTURE (Desktop)                                           │
│    User presses Ctrl+Shift+X                                   │
│    → Floating capture window opens                             │
│    → User types text, hits Enter                               │
│    → Tauri command `import_text` runs                          │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP POST /api/import
┌────────────────────────────────────────────────────────────────┐
│ 2. INGEST (cluster-hub)                                        │
│    Receives JSON: {text, title, topic, tags, source}           │
│    → Inserts into conversations table                          │
│    → Appends JSONL to ~/.local/share/xkg-mobile/from_desktop.jsonl │
│    → Returns {ok: true, id, total_imports}                     │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (polling or push)
┌────────────────────────────────────────────────────────────────┐
│ 3. PICKUP (Mobile)                                             │
│    xkg-mobile app starts                                       │
│    → reads ~/.local/share/xkg-mobile/from_desktop.jsonl       │
│    → imports conversations into local Hive box                 │
│    → indexes for full-text search                              │
└────────────────────────────────────────────────────────────────┘
```

## Why JSONL?

JSONL (JSON Lines) is the simplest possible cross-language, cross-platform sync format:
- Append-only (no race conditions)
- Human-readable
- Easy to parse in Python, Dart, Rust, JavaScript
- Crash-resilient (each line is independent)
- Diff-friendly (git tracks changes line-by-line)

## Schema

Each JSONL line in `from_desktop.jsonl`:

```json
{
  "source": "xkg-desktop",
  "synced_at": "2026-06-21T15:30:00.000Z",
  "conversation": {
    "id": "c_xyz",
    "provider": "grok",
    "external_id": "x_123",
    "title": "Tauri schema test",
    "created_at": "2026-06-15 16:01:46",
    "updated_at": "2026-06-15 16:01:46",
    "message_count": 2,
    "tags": ["local", "real"],
    "metadata": null
  },
  "messages": [
    {
      "id": "m_001",
      "conversation_id": "c_xyz",
      "author": "user",
      "content": "Real Tauri message",
      "timestamp": "2026-06-15 16:01:46",
      "model": "grok-3",
      "token_count": 12,
      "provider": "grok",
      "external_id": "ext_001",
      "created_at": "2026-06-15 16:01:46"
    }
  ]
}
```

## Conflict Resolution

**Last-write-wins** for now. If you capture the same text on two devices:
- Both devices POST to cluster-hub
- cluster-hub uses `(provider, external_id)` UNIQUE constraint
- First INSERT wins; second is a no-op (returns `duplicate: true`)

Future: vector clocks + CRDT for true offline-first sync.

## Privacy

- **No cloud** — Everything stays on your devices + your hub
- **No telemetry** — Zero outbound connections
- **No tracking** — No analytics, no cookies, no third-party requests
- **Open source** — Verify everything in the code

## Tailscale integration (recommended)

For multi-device sync over the internet without port forwarding:

1. Install [Tailscale](https://tailscale.com) on all devices + your hub server
2. Set `XKG_HUB_URL=http://your-hub.tailnet:8090` on each desktop
3. Mobile app settings: same Tailscale URL

Tailscale gives every device a stable IP (e.g., `100.x.x.x`) and encrypts all traffic.
