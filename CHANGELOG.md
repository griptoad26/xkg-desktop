# Changelog

## Unreleased — TASK-203 CS-X1 fix (cross-platform HKDF)

### Security
- **CS-X1**: device AES key derivation migrated from raw SHA-256
  to HKDF-SHA256 with canonical cross-platform parameters
  (salt=`xkg-v1`, info=`sync-encryption-v1`, output=32 bytes).
  Matches the mobile side's `SyncCrypto.hkdfKey()` exactly.
- **CS-X1**: added `set_sync_passphrase` Tauri command. Users type a
  passphrase on each device; both devices derive the same 32-byte
  AES key. Mobile + desktop ciphertexts now round-trip end-to-end.
- **CS-X1**: `local_encryption_key` now prefers the user-set
  passphrase over the per-install random key. The passphrase is
  stored in the OS keyring under a distinct slot (`sync_passphrase`).
- Cross-stack test vector pinned at
  `b93054311eba70a781cbebd08961d6841e540a95199936415febd727fb1989a5`
  for passphrase `"correct horse battery staple"`. The same hex is
  asserted in `xkg-mobile-flutter/test/sync_crypto_hkdf_test.dart`
  and `xkg-desktop/src-tauri/src/sync_command.rs::tests::derive_key_matches_mobile_cross_stack_vector`.

### Migration
- Existing desktop users without a passphrase keep their per-install
  random key. Sync to mobile requires both sides to set the same
  passphrase; until they do, sync continues to fail intentionally
  (the only safe behaviour — falling back to a different derivation
  would silently corrupt data).
- The user can clear the passphrase by submitting an empty string
  to `set_sync_passphrase`; this restores the random-key fallback.

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
