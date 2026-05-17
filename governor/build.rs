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

fn main() {
    ensure_frontend_stub();
    tauri_build::build();
}
