//! Icon assets embedded at compile time.
//!
//! The Raido rune (ᚱ, U+16B1) in iron-palette rust orange (#fa9c4c) is the
//! stavR brand mark per `CLAUDE.md` visual conventions. Each icon variant
//! corresponds to a Governor `DaemonState` and is swapped onto the tray icon
//! at runtime (wiring lives in P3 — `tray::apply_state`).
//!
//! Icons are generated from `icons/raido-base.svg` by
//! `scripts/gen_icons.py`; that script is the source of truth and CI re-runs
//! it before bundling. We embed the bytes here so the resulting binary is
//! self-contained (no filesystem icon lookup at runtime).

/// Magic bytes that begin every valid PNG file.
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Logical states that map 1:1 with `governor::state::DaemonState`. Re-declared
/// here as a small enum so the icons module stays standalone-testable without
/// pulling the supervisor module in. The mapping is the responsibility of
/// `tray::apply_state` (P3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconVariant {
    /// Default brand glyph — used as the bundle icon and the pre-launch tray
    /// state before the first health check returns.
    Brand,
    /// Daemon healthy — green halo.
    Healthy,
    /// Daemon degraded — amber halo.
    Degraded,
    /// Daemon down or in GiveUp — red halo.
    Down,
    /// Daemon stopped by operator — gray halo.
    StoppedManually,
    /// Restarting — rust-orange glyph (alternated with `RestartingDim` to
    /// produce a pulse without an animated icon format).
    Restarting,
    /// Pulse frame B for `Restarting` / `GiveUp`.
    RestartingDim,
}

impl IconVariant {
    /// Bytes for the 16x16 tray icon (used on Windows tray + Linux fallback).
    pub fn bytes_16(self) -> &'static [u8] {
        match self {
            IconVariant::Brand => include_bytes!("../icons/raido-16.png"),
            IconVariant::Healthy => include_bytes!("../icons/raido-green-16.png"),
            IconVariant::Degraded => include_bytes!("../icons/raido-yellow-16.png"),
            IconVariant::Down => include_bytes!("../icons/raido-red-16.png"),
            IconVariant::StoppedManually => include_bytes!("../icons/raido-gray-16.png"),
            IconVariant::Restarting => include_bytes!("../icons/raido-orange-16.png"),
            IconVariant::RestartingDim => include_bytes!("../icons/raido-orange-dim-16.png"),
        }
    }

    /// Bytes for the 32x32 tray icon (used on macOS retina + high-DPI Windows).
    pub fn bytes_32(self) -> &'static [u8] {
        match self {
            IconVariant::Brand => include_bytes!("../icons/raido-32.png"),
            IconVariant::Healthy => include_bytes!("../icons/raido-green-32.png"),
            IconVariant::Degraded => include_bytes!("../icons/raido-yellow-32.png"),
            IconVariant::Down => include_bytes!("../icons/raido-red-32.png"),
            IconVariant::StoppedManually => include_bytes!("../icons/raido-gray-32.png"),
            IconVariant::Restarting => include_bytes!("../icons/raido-orange-32.png"),
            IconVariant::RestartingDim => include_bytes!("../icons/raido-orange-dim-32.png"),
        }
    }

    /// All variants — used by tests to verify every embedded asset is valid.
    pub fn all() -> &'static [IconVariant] {
        &[
            IconVariant::Brand,
            IconVariant::Healthy,
            IconVariant::Degraded,
            IconVariant::Down,
            IconVariant::StoppedManually,
            IconVariant::Restarting,
            IconVariant::RestartingDim,
        ]
    }

    /// Pick the icon variant that should be displayed for a given daemon
    /// state. `pulse_phase` toggles each tick of the supervisor watcher;
    /// states that don't pulse ignore it and return a stable variant.
    ///
    /// State → variant mapping (BOM P3):
    /// - `Unknown`         → `Restarting` pulse (pre-probe heartbeat)
    /// - `Healthy`         → `Healthy` (green halo)
    /// - `Degraded`        → `Degraded` (amber halo)
    /// - `Down`            → `Down` (red halo)
    /// - `Restarting`      → `Restarting` / `RestartingDim` pulse (orange)
    /// - `StoppedManually` → `StoppedManually` (gray halo)
    /// - `GiveUp`          → `Down` / `RestartingDim` (red + alert pattern)
    pub fn for_state(state: crate::state::DaemonState, pulse_phase: bool) -> IconVariant {
        use crate::state::DaemonState;
        match state {
            DaemonState::Unknown | DaemonState::Restarting => {
                if pulse_phase {
                    IconVariant::RestartingDim
                } else {
                    IconVariant::Restarting
                }
            }
            DaemonState::Healthy => IconVariant::Healthy,
            DaemonState::Degraded => IconVariant::Degraded,
            DaemonState::Down => IconVariant::Down,
            DaemonState::StoppedManually => IconVariant::StoppedManually,
            DaemonState::GiveUp => {
                // Alert pattern: solid red + a "missing" beat using the dim
                // orange variant. The contrast between red and orange-dim
                // reads as "something is wrong" without needing a second
                // halo color set.
                if pulse_phase {
                    IconVariant::RestartingDim
                } else {
                    IconVariant::Down
                }
            }
        }
    }

    /// True if this state should pulse (animated tray icon). The watcher
    /// thread alternates `pulse_phase` only while pulsing states are active
    /// so the CPU stays idle in steady-state.
    pub fn state_pulses(state: crate::state::DaemonState) -> bool {
        use crate::state::DaemonState;
        matches!(
            state,
            DaemonState::Unknown | DaemonState::Restarting | DaemonState::GiveUp
        )
    }
}

/// Verify a byte slice begins with the canonical PNG signature.
///
/// We don't pull a full PNG decoder into the binary just to validate at
/// startup — the signature check is enough to catch a missing or truncated
/// asset, which is the realistic failure mode (CI mis-copy, filesystem
/// corruption). Tauri's image loader will reject anything malformed past
/// that point.
pub fn is_valid_png(bytes: &[u8]) -> bool {
    bytes.len() > PNG_MAGIC.len() && bytes[..PNG_MAGIC.len()] == PNG_MAGIC
}

/// Brand glyph 128x128 — embedded so the About dialog (P5) can show it
/// without re-reading the filesystem.
pub const BRAND_128: &[u8] = include_bytes!("../icons/raido-128.png");

/// Decoded RGBA pixel buffer + dimensions, returned by `decode_png_rgba`.
/// Tauri 2's `Image::new_owned` takes exactly this shape.
pub struct RgbaImage {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Decode a PNG byte slice into an RGBA pixel buffer.
///
/// Our icons are emitted by `gen_icons.py` as RGBA PNGs, but we normalize
/// other color types defensively so a future change to the script doesn't
/// silently break tray rendering. Returns an error string suitable for
/// surfacing through `anyhow`.
pub fn decode_png_rgba(bytes: &[u8]) -> Result<RgbaImage, String> {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("png read_info: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("png next_frame: {e}"))?;
    buf.truncate(info.buffer_size());

    let pixels = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            // expand RGB → RGBA (alpha 0xFF)
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in buf.chunks_exact(3) {
                out.extend_from_slice(chunk);
                out.push(0xFF);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in buf.chunks_exact(2) {
                let g = chunk[0];
                out.extend_from_slice(&[g, g, g, chunk[1]]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &g in buf.iter() {
                out.extend_from_slice(&[g, g, g, 0xFF]);
            }
            out
        }
        other => return Err(format!("unsupported PNG color type: {other:?}")),
    };

    Ok(RgbaImage {
        pixels,
        width: info.width,
        height: info.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brand_glyph_is_valid_png() {
        assert!(is_valid_png(IconVariant::Brand.bytes_16()));
        assert!(is_valid_png(IconVariant::Brand.bytes_32()));
        assert!(is_valid_png(BRAND_128));
    }

    #[test]
    fn every_state_variant_has_valid_png_at_both_sizes() {
        for &v in IconVariant::all() {
            assert!(
                is_valid_png(v.bytes_16()),
                "16px variant for {v:?} failed PNG magic check"
            );
            assert!(
                is_valid_png(v.bytes_32()),
                "32px variant for {v:?} failed PNG magic check"
            );
        }
    }

    #[test]
    fn png_validator_rejects_obvious_non_png() {
        assert!(!is_valid_png(b""));
        assert!(!is_valid_png(b"\x89PNG"));
        assert!(!is_valid_png(b"not a png at all but long enough"));
    }

    #[test]
    fn decode_png_rgba_returns_correct_dimensions() {
        let img = decode_png_rgba(IconVariant::Brand.bytes_32())
            .expect("32px brand glyph must decode");
        assert_eq!(img.width, 32);
        assert_eq!(img.height, 32);
        assert_eq!(img.pixels.len(), (32 * 32 * 4) as usize);

        let big = decode_png_rgba(BRAND_128).expect("128px brand glyph must decode");
        assert_eq!(big.width, 128);
        assert_eq!(big.height, 128);
    }

    #[test]
    fn for_state_maps_each_state_to_an_appropriate_variant() {
        use crate::state::DaemonState;
        // Steady states (no pulse) — pulse_phase must not change the result.
        assert_eq!(
            IconVariant::for_state(DaemonState::Healthy, false),
            IconVariant::Healthy
        );
        assert_eq!(
            IconVariant::for_state(DaemonState::Healthy, true),
            IconVariant::Healthy
        );
        assert_eq!(
            IconVariant::for_state(DaemonState::Degraded, false),
            IconVariant::Degraded
        );
        assert_eq!(
            IconVariant::for_state(DaemonState::Down, false),
            IconVariant::Down
        );
        assert_eq!(
            IconVariant::for_state(DaemonState::StoppedManually, false),
            IconVariant::StoppedManually
        );
    }

    #[test]
    fn for_state_pulses_restarting_and_giveup() {
        use crate::state::DaemonState;
        // Restarting alternates between Restarting and RestartingDim.
        let a = IconVariant::for_state(DaemonState::Restarting, false);
        let b = IconVariant::for_state(DaemonState::Restarting, true);
        assert_ne!(a, b, "Restarting must pulse — both phases produced {a:?}");

        // GiveUp uses a different alert pattern (red ↔ orange-dim).
        let g_a = IconVariant::for_state(DaemonState::GiveUp, false);
        let g_b = IconVariant::for_state(DaemonState::GiveUp, true);
        assert_ne!(g_a, g_b, "GiveUp must pulse — both phases produced {g_a:?}");
        assert_eq!(g_a, IconVariant::Down);

        // Unknown also pulses (pre-probe heartbeat).
        let u_a = IconVariant::for_state(DaemonState::Unknown, false);
        let u_b = IconVariant::for_state(DaemonState::Unknown, true);
        assert_ne!(u_a, u_b);
    }

    #[test]
    fn state_pulses_predicate_matches_for_state_behaviour() {
        use crate::state::DaemonState;
        for state in [
            DaemonState::Unknown,
            DaemonState::Healthy,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Restarting,
            DaemonState::StoppedManually,
            DaemonState::GiveUp,
        ] {
            let pulses = IconVariant::state_pulses(state);
            let a = IconVariant::for_state(state, false);
            let b = IconVariant::for_state(state, true);
            if pulses {
                assert_ne!(
                    a, b,
                    "state_pulses({state:?}) says yes but for_state returned the same variant"
                );
            } else {
                assert_eq!(
                    a, b,
                    "state_pulses({state:?}) says no but for_state varied"
                );
            }
        }
    }

    #[test]
    fn halo_variants_differ_from_brand() {
        // Sanity: each colored halo variant produces different bytes than the
        // base brand glyph at the same size. If gen_icons.py ever regresses to
        // producing the same image for every color, this test catches it.
        let brand = IconVariant::Brand.bytes_32();
        for &v in &[
            IconVariant::Healthy,
            IconVariant::Degraded,
            IconVariant::Down,
            IconVariant::StoppedManually,
        ] {
            assert_ne!(
                v.bytes_32(),
                brand,
                "halo variant {v:?} bytes equal brand bytes — gen_icons.py likely regressed"
            );
        }
    }
}
