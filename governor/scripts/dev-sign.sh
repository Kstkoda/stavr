#!/usr/bin/env bash
# dev-sign.sh — sign a local Governor dev build on macOS or Linux.
#
# Per BOM v0.6.5.1 P3.
#
# macOS:
#   * Uses `codesign --sign -` for ad-hoc signing, which is enough to keep
#     Gatekeeper from refusing the binary outright in dev (operator still
#     needs `xattr -d com.apple.quarantine` for downloaded artifacts).
#   * If a Developer ID identity is present in keychain, signs with it
#     instead — closer to a release signature but still operator-owned.
#
# Linux:
#   * Linux has no SAC/Gatekeeper equivalent. The closest "trust" gesture
#     is a detached GPG signature next to the binary; this script emits
#     ${binary}.gpg.sig if the operator has a default GPG signing key.
#   * Otherwise prints a no-op message — Linux dev builds run unsigned.
#
# REMINDER: dev signatures are local-only. Do NOT distribute a dev-signed
# binary; release distribution goes through the Sigstore keyless pipeline
# (governor-release.yml).

set -euo pipefail

BINARY_PATH="${1:-}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
GOVERNOR_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)

if [[ -z "${BINARY_PATH}" ]]; then
  HOST_TRIPLE=$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}' || true)
  if [[ -n "${HOST_TRIPLE}" && -f "${GOVERNOR_DIR}/target/${HOST_TRIPLE}/release/stavr-governor" ]]; then
    BINARY_PATH="${GOVERNOR_DIR}/target/${HOST_TRIPLE}/release/stavr-governor"
  elif [[ -f "${GOVERNOR_DIR}/target/release/stavr-governor" ]]; then
    BINARY_PATH="${GOVERNOR_DIR}/target/release/stavr-governor"
  else
    echo "[dev-sign] FAIL: could not auto-discover Governor binary. Pass an explicit path." >&2
    echo "[dev-sign] usage: $0 <path-to-binary>" >&2
    exit 2
  fi
fi

if [[ ! -f "${BINARY_PATH}" ]]; then
  echo "[dev-sign] FAIL: binary not found: ${BINARY_PATH}" >&2
  exit 1
fi

OS_NAME=$(uname -s)
case "${OS_NAME}" in
  Darwin)
    # Prefer a real Developer ID identity if available, else fall back to ad-hoc.
    DEV_ID=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/ {print $2; exit}')
    if [[ -n "${DEV_ID}" ]]; then
      echo "[dev-sign] using Developer ID identity: ${DEV_ID}"
      codesign --force --options runtime --timestamp --sign "${DEV_ID}" "${BINARY_PATH}"
    else
      echo "[dev-sign] no Developer ID found; ad-hoc signing (Gatekeeper will still complain on downloaded copies)"
      codesign --force --sign - "${BINARY_PATH}"
    fi
    echo "[dev-sign] verifying signature"
    codesign --verify --verbose "${BINARY_PATH}"
    echo "[dev-sign] OK: ${BINARY_PATH} signed (macOS)"
    ;;
  Linux)
    if command -v gpg >/dev/null 2>&1 && gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep -q '^sec'; then
      OUT="${BINARY_PATH}.gpg.sig"
      echo "[dev-sign] generating detached GPG signature -> ${OUT}"
      gpg --detach-sign --armor --output "${OUT}" "${BINARY_PATH}"
      echo "[dev-sign] verifying signature"
      gpg --verify "${OUT}" "${BINARY_PATH}"
      echo "[dev-sign] OK: detached GPG signature next to binary"
    else
      echo "[dev-sign] note: no GPG signing key found; Linux dev builds run unsigned." >&2
      echo "[dev-sign] note: Linux has no SAC/Gatekeeper analogue, so this is usually fine for local dev." >&2
      echo "[dev-sign] note: see docs/governor-local-dev.md for the verify-then-trust release flow." >&2
      exit 0
    fi
    ;;
  *)
    echo "[dev-sign] FAIL: unsupported platform: ${OS_NAME}" >&2
    echo "[dev-sign]   Windows path: use governor/scripts/dev-sign.ps1" >&2
    exit 1
    ;;
esac

echo "[dev-sign] REMINDER: dev signatures are local-only. Do not distribute."
