#!/usr/bin/env bash
# gen-sbom.sh — generate a CycloneDX SBOM for the Governor crate locally.
#
# Wraps `cargo cyclonedx` with stavR conventions so the local SBOM is
# shape-interchangeable with the CI-published artifact (per ADR-038 §1 and
# BOM v0.6.5.1 P2).
#
# Usage:
#   ./gen-sbom.sh                                      # host target
#   ./gen-sbom.sh -t x86_64-unknown-linux-gnu
#   ./gen-sbom.sh -o my-sbom.cdx.json
#
# Requires: cargo + cargo-cyclonedx on PATH.
#   cargo install cargo-cyclonedx --version 0.5.7 --locked

set -euo pipefail

TARGET=""
OUTPUT="stavr-governor.sbom.cdx.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) TARGET="$2"; shift 2 ;;
    -o|--output) OUTPUT="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,15p' "$0"
      exit 0
      ;;
    *) echo "[gen-sbom] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  echo "[gen-sbom] FAIL: cargo not on PATH (install from https://rustup.rs/)" >&2
  exit 1
fi

if ! cargo cyclonedx --version >/dev/null 2>&1; then
  echo "[gen-sbom] FAIL: cargo-cyclonedx not installed" >&2
  echo "[gen-sbom]   install: cargo install cargo-cyclonedx --version 0.5.7 --locked" >&2
  exit 1
fi

if [[ -z "${TARGET}" ]]; then
  TARGET=$(rustc -vV | awk '/^host:/ {print $2}')
  if [[ -z "${TARGET}" ]]; then
    echo "[gen-sbom] FAIL: could not determine host target" >&2
    exit 1
  fi
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
GOVERNOR_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)

cd "${GOVERNOR_DIR}"

echo "[gen-sbom] generating SBOM for target ${TARGET}"
cargo cyclonedx --target "${TARGET}" --format json --output-pattern bom

# cargo-cyclonedx emits <crate>.cdx.json next to Cargo.toml.
EMITTED=$(find . -maxdepth 1 -name '*.cdx.json' ! -name "${OUTPUT}" -print -quit || true)
if [[ -n "${EMITTED}" ]]; then
  mv -f "${EMITTED}" "${OUTPUT}"
fi

if [[ ! -f "${OUTPUT}" ]]; then
  echo "[gen-sbom] FAIL: SBOM output not produced at ${OUTPUT}" >&2
  exit 1
fi

SIZE=$(wc -c < "${OUTPUT}")
echo "[gen-sbom] OK: ${OUTPUT} (${SIZE} bytes)"
