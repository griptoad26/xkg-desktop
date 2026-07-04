//! Library shim for `xkg-desktop`.
//!
//! The bulk of the desktop's logic lives in `main.rs` and its sibling
//! modules (`xkg`, `sync_command`, `shortcuts`). The binary crate
//! alone, however, can't be linked from `tests/*.rs` integration
//! files — cargo only exposes a `lib.rs` to those. This shim
//! re-exports the small handful of items integration tests need to
//! call into, primarily the `build_continue_url` helper backing the
//! `continue_in_browser` Tauri command.
//!
//! The binary `main.rs` keeps owning its own module declarations
//! (`mod xkg; mod sync_command; mod shortcuts;`) so production
//! behavior is unchanged; this file is purely a re-export surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Pull the modules in. The binary also declares them, but each
// compilation unit (lib vs bin) has its own `mod` namespace, so the
// duplication is harmless.
pub mod shortcuts;
pub mod sync_command;
pub mod xkg;

// Re-export the testable surface area so integration tests can
// `use xkg_desktop::build_continue_url;` directly.
pub use xkg::build_continue_url;
