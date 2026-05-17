//! stavR Governor — library crate.
//!
//! Modules are split so they can be unit-tested without spinning up the Tauri
//! runtime. `main.rs` wires them together. See `adr/033-stavr-tray-companion.md`
//! and `adr/040-three-process-architecture.md` for the architectural shape.

pub mod icons;
