// Governor is a tray-only app — no frontend assets to bundle. Tauri 2's
// build pipeline still wants a `frontendDist` directory to exist, so we
// emit a one-line placeholder at build time. The directory is gitignored
// (the repo's root .gitignore matches `dist/`), so this keeps clean checkouts
// working without force-adding a stub.
fn ensure_frontend_stub() {
    use std::fs;
    use std::path::Path;
    let dist = Path::new("dist");
    if !dist.exists() {
        fs::create_dir_all(dist).expect("create governor/dist");
    }
    let index = dist.join("index.html");
    if !index.exists() {
        fs::write(
            &index,
            "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>stavR Governor</title></head><body></body></html>\n",
        )
        .expect("write governor/dist/index.html");
    }
}

/// Phase 4 of family-mode-phase-2: tauri.conf.json declares the daemon
/// SEA as an `externalBin` sidecar. tauri-build validates that the
/// per-target binary exists at every `cargo check` / `cargo build` —
/// including dev runs where the SEA hasn't been built. Create a tiny
/// placeholder so the validation passes; CI overwrites it with the real
/// SEA before `cargo tauri build` runs the bundler. The `binaries/`
/// directory is gitignored.
fn ensure_sidecar_placeholder() {
    use std::fs;
    use std::path::Path;
    let target_triple = std::env::var("TARGET").unwrap_or_default();
    if target_triple.is_empty() {
        // No TARGET env — extremely unusual (would only happen if this
        // build.rs is run outside cargo). Skip; tauri-build will surface
        // a clearer error.
        return;
    }
    let ext = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let dir = Path::new("binaries");
    if !dir.exists() {
        fs::create_dir_all(dir).expect("create governor/binaries");
    }
    let file = dir.join(format!("stavr-daemon-{target_triple}{ext}"));
    if !file.exists() {
        // 1-byte placeholder so the file system entry exists; CI replaces
        // this with the real SEA (~120 MB) before bundling. The content
        // is intentionally minimal — anyone running `cargo run` from the
        // repo is in dev mode and will hit the `Pm2Restarter` fallback
        // via main.rs's `resolve_sidecar_path` (which only returns Some
        // when the resolved binary actually exists and is non-empty
        // enough to be plausibly the daemon — see lib::restart docs).
        fs::write(&file, b"#").expect("write sidecar placeholder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&file)
                .expect("stat sidecar placeholder")
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&file, perms).expect("chmod sidecar placeholder");
        }
    }
}

fn main() {
    ensure_frontend_stub();
    ensure_sidecar_placeholder();
    tauri_build::build();
}
