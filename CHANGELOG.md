# Changelog

## v0.1.0 (2026-06-21) — Initial Release

### Desktop
- Tauri 2.x + Svelte + Vite 5
- Global keyboard shortcut (Ctrl+Shift+X, configurable)
- Local SQLite with FTS5 full-text search
- System tray with settings panel
- Autostart on login
- Cross-compile pipeline: Linux deb/rpm/AppImage, Windows NSIS+MSI, macOS DMG (via CI)

### Sync
- HTTP POST to cluster-hub `/api/import`
- JSONL bridge file for xkg-mobile pickup
- Provider-agnostic (Grok, Claude, ChatGPT, Gemini, etc.)

### Cross-platform
- Linux: x86_64 (.deb, .rpm, .AppImage)
- Windows: x86_64 (NSIS installer, MSI)
- macOS: x86_64 + aarch64 (.dmg via GitHub Actions)
