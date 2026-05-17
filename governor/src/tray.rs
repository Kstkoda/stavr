//! Tauri 2 tray-icon wiring.
//!
//! P1 scope: build the tray with the brand glyph and a single "Quit" menu
//! item. State-driven icon swapping (`apply_state`) lands in P3. The full
//! operator menu (open dashboard / pause / restart / mute) lands in P5
//! per the v0.6.5 BOM phase plan.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Runtime,
};

use crate::icons::{decode_png_rgba, IconVariant};

/// Build the Governor tray icon and attach it to the running Tauri app.
///
/// Returns the live `TrayIcon` so callers (P3 supervisor wiring) can update
/// its image and tooltip as `DaemonState` changes.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let quit = MenuItem::with_id(app, "quit", "Quit Governor", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    let icon = load_icon(IconVariant::Brand)?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("stavR · starting…")
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                // Hard rule #4: quitting the Governor does NOT stop the
                // daemon. PM2 keeps the daemon alive; the operator simply
                // loses the supervision + status surface until they relaunch
                // Governor.
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(tray)
}

/// Decode an `IconVariant`'s 32px PNG into a Tauri `Image`. 32px is the
/// platform-portable middle ground — Windows tray rescales it down at low DPI
/// and macOS uses it directly at retina. The 16px variant is reserved for the
/// Linux fallback path we will wire up if/when the GTK status-icon mode is
/// needed (Wayland-only desktops don't expose tray at all; that's a P6 doc
/// note, not a code path).
///
/// Tauri 2's `Image` takes raw RGBA, not encoded PNG, so we decode through the
/// `png` crate at startup. The bytes are static, so decode cost is one-time.
pub fn load_icon(variant: IconVariant) -> tauri::Result<Image<'static>> {
    let rgba = decode_png_rgba(variant.bytes_32())
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("icon decode failed: {e}")))?;
    Ok(Image::new_owned(rgba.pixels, rgba.width, rgba.height))
}
