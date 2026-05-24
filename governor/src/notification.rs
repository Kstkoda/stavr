//! OS toast renderer via `tauri-plugin-notification` v2.
//!
//! Implements the [`crate::event_router::ToastRenderer`] trait so the router
//! can call into the Tauri notification plugin without leaking Tauri types
//! across the router boundary (keeps `event_router.rs` unit-testable without
//! a Tauri app context).
//!
//! Severity → toast attribute mapping (per BOM P4):
//!   info → default priority, no sound
//!   warn → default priority, no sound (deliberately quiet on Windows where
//!          every toast already animates + auto-dismisses)
//!   crit → sound enabled (and on macOS, the plugin's `interruption_level`
//!          would make it persistent — that's plugin-internal)
//!
//! Per BOM P4, every toast renders silently if the plugin fails — the
//! Governor must NEVER crash because the OS notification surface is
//! misconfigured. Failures are logged at `warn`.
//!
//! ### Phase 3 — approval-needed click routing
//!
//! `tauri-plugin-notification` 2.x does NOT expose a desktop click /
//! action callback to the Rust side (the `register_listener` command is
//! mobile-only — see the plugin's `commands/register_listener.toml`).
//! The body-click behavior of an OS toast on Windows / macOS / Linux is
//! whatever the platform default is — usually "open the source app",
//! which for a tray-only Governor means "do nothing visible." Until a
//! cross-platform Rust click handler lands upstream, the operator's
//! reliable path from an approval notification to the Decide queue is
//! the tray menu's **View Decide Queue** item (Phase 1 surface).
//!
//! The notification body itself starts with "Approval needed:" so the
//! operator knows what to do; the Crit severity ensures a sound on every
//! platform. Once upstream exposes a click callback, route to
//! `actions::open_dashboard(app, "/dashboard/decide")` here.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::event_router::{Severity, ToastRenderer, ToastSpec};

/// Production renderer. Holds an `AppHandle` clone (which is Send + Sync in
/// Tauri 2) so it can be called from any thread.
pub struct TauriToastRenderer<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriToastRenderer<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> ToastRenderer for TauriToastRenderer<R> {
    fn render(&self, spec: &ToastSpec) {
        let mut builder = self
            .app
            .notification()
            .builder()
            .title(spec.title.clone())
            .body(spec.body.clone());
        // Sound: crit-only. Tauri plugin uses a string sound name; "default"
        // is the OS default tone on each platform.
        if matches!(spec.severity, Severity::Crit) {
            builder = builder.sound("default");
        }
        if let Err(e) = builder.show() {
            log::warn!(
                "notification: render failed for kind={} severity={:?}: {e}",
                spec.kind,
                spec.severity
            );
        } else {
            log::info!(
                "notification: rendered kind={} severity={:?} title={:?}",
                spec.kind,
                spec.severity,
                spec.title
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::event_router::{Severity, ToastSpec};

    /// We can't unit-test the plugin call (it requires a running Tauri app)
    /// but we can keep a couple of shape assertions to lock the API in.
    #[test]
    fn toast_spec_round_trips() {
        let s = ToastSpec {
            kind: "x".into(),
            title: "t".into(),
            body: "b".into(),
            severity: Severity::Crit,
        };
        let cloned = s.clone();
        assert_eq!(s, cloned);
        assert_eq!(cloned.severity, Severity::Crit);
    }
}
