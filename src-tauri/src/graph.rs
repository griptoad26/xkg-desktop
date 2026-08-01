//! Knowledge-graph linker Tauri commands — Phase 167 / TASK-HUB-20260731-167.
//!
//! The actual command bodies live in [`crate::xkg`] alongside the other
//! Phase-2/3 commands (capture_html, list_conversations, ...). This file
//! is a thin re-export surface so the xkg-core linker code has a single
//! import path callers can grep for.
//!
//! ## Commands
//!
//! * [`crate::xkg::graph_link`] — compute TF-IDF cosine between a
//!   conversation and every other conversation in the store; persist
//!   rows in `conversation_links` for any pair above the threshold.
//!   Idempotent (UNIQUE(source, target, link_type)).
//! * [`crate::xkg::graph_unlink`] — delete a single typed link.
//! * [`crate::xkg::graph_query`] — BFS over `conversation_links` from
//!   `root_id` up to `depth` hops; returns a [`xkg_core::linker::SubGraph`]
//!   with nodes (depth-tagged) and edges (preserving the directional
//!   source/target columns from the table).
//! * [`crate::xkg::topic_graph_query`] — the pre-existing FTS5-based
//!   topic graph (per-message bigram/trigram phrases). Different
//!   semantics; kept as a sibling command for the Graph.svelte tab.
//!
//! ## Why two `graph_query`-shaped commands?
//!
//! The TASK-167 spec calls `graph_query(root_id, depth)` the BFS
//! subgraph over `conversation_links`. Phase 3 already shipped a
//! method named `CaptureStore::graph_query` that builds an FTS5
//! topic graph from a free-form query string. To honour the spec
//! without breaking the existing UI, we renamed the FTS5 method to
//! `topic_graph_query` and reserved `graph_query` for the BFS
//! behaviour the spec asks for. Both are exposed as Tauri commands.

// The re-exports below are not consumed inside this crate (the Tauri
// command list lives in `main.rs` and pulls the symbols directly out
// of `xkg`), but exposing them through `crate::graph` lets downstream
// integration tests and docs reference a single import path. Mark
// them allow(unused_imports) so the warning stays out of CI logs.
#[allow(unused_imports)]
pub use crate::xkg::{graph_link, graph_query, graph_unlink, topic_graph_query};