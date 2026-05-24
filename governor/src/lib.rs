//! stavR Governor — library crate.
//!
//! Modules are split so they can be unit-tested without spinning up the Tauri
//! runtime. `main.rs` wires them together. See `adr/033-stavr-tray-companion.md`,
//! `adr/040-three-process-architecture.md`, and
//! `proposed/governor-observe-only-bom.md` for the architectural shape.
//!
//! Phase 1 of the operator-companion refactor deleted the `restart` and
//! `port_check` modules outright — the OS-native StavrDaemon service is
//! the daemon's sole supervisor and Governor has no auto-restart wiring.

pub mod actions;
pub mod event_bridge;
pub mod event_router;
pub mod heartbeat;
pub mod icons;
pub mod notification;
pub mod service;
pub mod state;
pub mod supervisor;
