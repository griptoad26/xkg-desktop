# XKG Desktop

> **Capture knowledge from anywhere. Sync to everywhere.**

XKG Desktop is a cross-platform system-tray utility that lets you capture text, conversations, and ideas from any application via a global keyboard shortcut, and sync them across all your devices via the X Knowledge Graph.

## Features

- 🌍 **Global hotkey** — Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on macOS) anywhere to capture
- 💾 **Local-first** — All data stored in SQLite on your device
- 🔄 **Auto-sync** — Captures post to your cluster-hub and propagate to your phone
- 🔍 **Full-text search** — FTS5 indexing across all conversations
- 🚀 **Cross-platform** — Linux, Windows, macOS (Intel + Apple Silicon)
- 🪶 **Tiny** — Single binary, ~20 MB on disk, <100 MB RAM

## Installation

### Linux
```bash
# Debian/Ubuntu
sudo dpkg -i XKG-Desktop_0.1.0_amd64.deb

# Fedora/RHEL
sudo rpm -i XKG-Desktop-0.1.0-1.x86_64.rpm

# Universal (no install)
chmod +x XKG-Desktop_0.1.0_amd64.AppImage
./XKG-Desktop_0.1.0_amd64.AppImage
```

### Windows
```powershell
# Installer (recommended — adds to Start Menu, autostart)
XKG-Desktop_0.1.0_x64-setup.exe

# Or enterprise MSI for system administrators
msiexec /i XKG-Desktop_0.1.0_x64_en-US.msi
```

### macOS
```bash
# Apple Silicon
open XKG-Desktop_0.1.0_aarch64.dmg

# Intel
open XKG-Desktop_0.1.0_x64.dmg
```

## Quick Start

1. **Launch** — The app starts minimized to the system tray
2. **Press Ctrl+Shift+X** anywhere — A small floating window appears
3. **Type or paste** — Your text, conversation, or note
4. **Press Enter or click Save** — The capture posts to your cluster-hub
5. **Open on your phone** — Run xkg-mobile to see the same captures

## Cross-Device Sync

XKG Desktop is part of the X Knowledge Graph ecosystem:

```
┌─────────────────┐  HTTP   ┌──────────────┐  JSONL   ┌──────────────┐
│  XKG Desktop    │ ──────► │ cluster-hub  │ ──────► │  XKG Mobile  │
│  (this app)     │ /import │  (port 8090) │  /sync   │  (Flutter)   │
└─────────────────┘         └──────────────┘         └──────────────┘
        │                                                    │
        │                                                    │
        ▼                                                    ▼
   Local SQLite                                       Mobile SQLite
   xkg-desktop.db                                     xkg_mobile_shell
   FTS5 indexed                                       Hive boxed
```

**Default cluster-hub:** `http://127.0.0.1:8090`
**Override:** Set `XKG_HUB_URL` environment variable

## Architecture

### Process model
- **Main process**: Tauri shell, system tray, global shortcut handler
- **Settings window**: Svelte UI for configuring hub URL, hotkey, autostart
- **Capture window**: Svelte UI for text input, hidden by default, shown on shortcut
- **Local database**: SQLite at `~/.local/share/xkg-desktop/xkg-desktop.db`

### Database schema
- `providers` — Grok, Claude, ChatGPT, Gemini, etc. (encrypted API keys)
- `conversations` — One per chat thread, FTS5 indexed
- `messages` — Individual messages within conversations
- `sync_log` — Audit trail of every sync attempt

### Sync flow
1. User presses `Ctrl+Shift+X`
2. Capture window opens with focused textarea
3. User types + hits Enter
4. `import_text` Tauri command runs
5. POST to `cluster-hub:/api/import` with `{text, title, topic, tags, source: "xkg-desktop"}`
6. Cluster hub persists to its own DB and writes JSONL to `~/.local/share/xkg-mobile/from_desktop.jsonl`
7. Mobile app reads JSONL on next sync

## Configuration

### Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `XKG_HUB_URL` | `http://127.0.0.1:8090` | cluster-hub endpoint |
| `XKG_GLOBAL_SHORTCUT` | `Ctrl+Shift+X` | Hotkey combination |

### Settings window
- Endpoint URL
- Global shortcut
- Autostart on login

## Building from Source

```bash
git clone https://github.com/griptoad26/xkg-desktop.git
cd xkg-desktop

# Install dependencies
npm install

# Run in dev mode
npm run tauri dev

# Build release
npm run tauri build
```

### Cross-platform builds
See `.github/workflows/release.yml` for the full matrix:
- `ubuntu-22.04` → `.deb`, `.rpm`, `.AppImage`
- `windows-latest` → NSIS installer, MSI
- `macos-latest` → `.app`, `.dmg` (Intel + Apple Silicon)

## License

MIT — see LICENSE file
