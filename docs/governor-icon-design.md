# Governor icon design — why the Raido rune (ᚱ)

The Governor's tray icon is the operator's first contact with stavR every
working day. The choice of glyph is not decoration — it's the brand mark,
and it carries the project's posture.

## The glyph

**ᚱ** — the Raido rune, U+16B1 in the Runic Unicode block. Phonetic value
*r*, traditionally interpreted in the Elder Futhark as "ride / journey /
the act of moving with intent". Visually: a vertical stem, a triangular
upper bowl, a diagonal leg — angular, asymmetric, immediately
distinguishable from Latin letters even at 16×16.

```text
     ┌──╴
    ─┤
     └──╲
```

In the iron palette, the canonical rendering is rust orange (`#fa9c4c`)
on a transparent background. The orange reads on every OS tray theme —
dark Windows 11, light macOS, GNOME's Adwaita — and it's visually
distinct from the system's blue/green/red status icons.

## Why a rune

stavR is a project about **authority that the operator owns**. The brand
mark needs to feel like a stamp, a maker's mark, a sigil — not a logo
shaped by a marketing rubric. Three properties mattered:

1. **One stroke of recognition.** Operators glance at the tray. The icon
   has ~50 ms to register. A unique silhouette beats a familiar one
   (every cloud-bucket / chat-app logo is a rounded square; every IDE is
   a stylised letter). The rune's asymmetry survives down-scaling and
   monochrome rendering on low-DPI displays.

2. **Cultural neutrality, technical specificity.** The Elder Futhark
   predates every modern political symbol the runes have been
   appropriated into. Raido specifically is not in the set of runes that
   carry recent extremist baggage (those are predominantly the *sōwilō*
   and *tiwaz* shapes). Choosing Raido is an explicit choice — a
   journey-rune for a tool that mediates the operator's journey across
   AI / tool / model boundaries.

3. **Operator-owned identity.** The rune was historically inscribed by
   the maker into their own work. stavR is the operator's authority and
   audit layer; the rune posture reinforces that *the operator stamps
   their tools*, not the other way around.

## State-driven variants

The icon swaps to communicate `DaemonState` (see `governor/src/state.rs`).
Status comes from the halo ring color, never from the glyph itself — the
glyph is identity, the halo is signal. Per CLAUDE.md visual conventions
(§5: "Status = halo ring, type = node color"):

| State | Halo color | When |
|---|---|---|
| `Unknown` | iron orange pulsing | first 60 s after Governor launch |
| `Healthy` | iron green (#5fd987) | daemon responding to /healthz |
| `Degraded` | iron amber (#ffd95a) | health probes flaking, settle window open |
| `Down` | iron red (#ff7a7a) | daemon unresponsive, auto-restart in progress |
| `Restarting` | iron orange pulsing | restart command in flight |
| `StoppedManually` | iron neutral gray (#8a8a8a) | operator clicked Pause |
| `GiveUp` | iron red + pulse | 5 failed restarts in 5 min; operator action required |

The pulse runs at 2 Hz (icon swaps every 500 ms via the tray-watcher thread
in `governor/src/main.rs`). Slow enough to read; fast enough to feel
urgent.

## Asset pipeline

Source: `governor/icons/raido-base.svg` — hand-traced from a Noto Sans
Runic reference at 1024×1024 so the glyph survives any downscale. The
build script `governor/scripts/gen_icons.py` rasterises to PNG at 16, 32,
64, 128, 256, 512, 1024 plus per-state halo variants. Windows `.ico` and
macOS `.icns` are derived from the 256/128 PNGs.

Tauri 2's `Image::new_owned()` consumes raw RGBA, so the runtime icon
swap path decodes the PNG once at startup (per-variant, via the `png`
crate) and caches in memory. The decode cost is one-time; the swap is a
memcpy of pre-decoded RGBA.

## What we deliberately did NOT do

- **No animated SVG.** Tauri tray icon API takes raster; pulsing is done
  by alternating two pre-rendered frames at 2 Hz from the watcher thread.
  Simpler, more portable, and the visual difference is imperceptible.
- **No "tiny logo wordmark" inside the icon.** At 16×16 the only thing
  legible is the rune silhouette. Adding "stavR" text in 4-pixel-tall
  letters would just make the icon muddy.
- **No emoji-style multicolour.** The rune is a single foreground glyph
  on transparent. The halo is the secondary color. Two channels max so
  the icon survives high-contrast accessibility settings.

## Don't recolor without operator consent

The iron-palette rust orange (#fa9c4c) is the canonical brand color.
A future "themed" build (e.g. dark / light tray adaptation) is a v1.1+
candidate and would need explicit operator opt-in via the tray menu —
not an OS-theme follower toggle. The mark is the operator's stamp; OS
theme detection should never override it silently.

