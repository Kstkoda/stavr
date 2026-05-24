//! Icon assets embedded at compile time.
//!
//! The Raido rune (ᚱ, U+16B1) is the stavR brand mark. Per the
//! governor-polish BOM Cluster A (concept 6, "bare glyph") the tray icon
//! is the rune alone — **no tile, no circle, no halo**. Status is
//! conveyed by the colour of the rune itself: rust = brand/idle, green =
//! healthy, amber = degraded, red = down, grey = stopped manually.
//!
//! This is an operator-approved exception to `CLAUDE.md` §5 ("status =
//! halo ring; never use colour to signal status"). §5 governs topology
//! nodes in the dashboard graph; a 16 px tray icon has no room for a
//! halo, and Kenneth explicitly chose "no circle" for the tray. The
//! canonical visual is `design-mockups/dock-icon-mockups.html`.
//!
//! Icons are generated from `icons/raido-base.svg` by
//! `scripts/gen_icons.py`; that script is the source of truth and CI re-runs
//! it before bundling. We embed the bytes here so the resulting binary is
//! self-contained (no filesystem icon lookup at runtime).
//!
//! **Note on the removed pulse animation (audit #8):** the old supervisor
//! made the tray icon pulse between `Restarting` and `RestartingDim`
//! frames while the daemon was in `DaemonState::Unknown` or
//! `DaemonState::Restarting`. The observe-only refactor (Phase 1)
//! removed supervision; `apply_state` no longer animates. The previously
//! dead variants and `IconVariant::for_state` / `state_pulses` helpers
//! were dropped in Cluster E; the dim-orange pulse PNGs were retired by
//! Cluster A (concept-6 redraw). A future restoration would mean adding
//! a new variant + helpers here AND a fresh pulse-frame asset.

/// Magic bytes that begin every valid PNG file.
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Logical pip variants. Each maps 1:1 with a `tray::PipColor`; the
/// `Brand` variant is reserved for the bundle icon + the pre-launch
/// placeholder before the first tray-watcher tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconVariant {
    /// Default brand glyph — bundle icon + pre-launch tray placeholder.
    Brand,
    /// Pip color: green — service running + daemon healthy.
    Healthy,
    /// Pip color: amber — service running + daemon degraded/unknown.
    Degraded,
    /// Pip color: red — service stopped, or service running + daemon down.
    Down,
    /// Pip color: grey — service not installed / operator-held.
    StoppedManually,
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
        ]
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

    /// Cluster E (audit #8): the `Restarting{,Dim}` variants and the
    /// `for_state` / `state_pulses` helpers are gone. Anchor the
    /// removal so a future restoration of the pulse animation has to
    /// be deliberate (see the module-level doc comment).
    #[test]
    fn pulse_variants_and_helpers_are_removed() {
        // Source-level anchor: production code must not reference the
        // removed variants or helpers.
        let src = include_str!("icons.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("icons.rs non-test prelude");
        for forbidden in [
            "IconVariant::Restarting",
            "IconVariant::RestartingDim",
            "fn for_state",
            "fn state_pulses",
        ] {
            assert!(
                !prod.contains(forbidden),
                "icons.rs prod must not contain {forbidden:?} after Cluster E removal"
            );
        }
    }

    #[test]
    fn status_variants_differ_from_brand() {
        // Sanity: each status-colour variant produces different bytes than
        // the brand glyph at the same size. Cluster A (concept 6, bare
        // glyph) recolours the entire rune — green/amber/red/grey must
        // all produce distinct PNGs. If gen_icons.py regresses to a
        // single colour for everything, this test catches it.
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
                "status variant {v:?} bytes equal brand bytes — gen_icons.py likely regressed"
            );
        }
    }
}
