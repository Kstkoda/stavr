#!/usr/bin/env bash
# install-from-release.sh — verify-then-trust install of a signed stavR Governor
# release on macOS/Linux. Per BOM v0.6.5.1 P4.
#
# Usage:
#   ./install-from-release.sh                              # latest, host arch
#   VERSION=v0.6.5 ./install-from-release.sh
#   VERSION=v0.6.5 ARCH=aarch64 ./install-from-release.sh
#   SKIP_VERIFY=1 ./install-from-release.sh                # NOT RECOMMENDED

set -euo pipefail

REPO="${REPO:-Kstkoda/stavr}"
VERSION="${VERSION:-latest}"
ARCH="${ARCH:-auto}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.stavr/governor}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [[ "${ARCH}" == "auto" ]]; then
  raw=$(uname -m)
  case "${raw}" in
    x86_64|amd64) ARCH="x86_64" ;;
    arm64|aarch64) ARCH="aarch64" ;;
    *) echo "[install] FAIL: unsupported arch: ${raw}" >&2; exit 1 ;;
  esac
fi
echo "[install] target arch: ${ARCH}"

if [[ "${VERSION}" == "latest" ]]; then
  echo "[install] resolving latest release"
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
             -H 'User-Agent: stavr-installer' \
             -H 'Accept: application/vnd.github+json' \
             | awk -F'"' '/"tag_name"/ {print $4; exit}')
  if [[ -z "${VERSION}" ]]; then echo "[install] FAIL: could not resolve latest tag" >&2; exit 1; fi
  echo "[install] latest = ${VERSION}"
fi

if [[ "${VERSION}" != v0.6.5* ]]; then
  echo "[install] FAIL: tag '${VERSION}' does not match Governor release pattern v0.6.5*." >&2
  exit 1
fi

ASSET="stavr-governor"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"

mkdir -p "${INSTALL_DIR}"
BIN_PATH="${INSTALL_DIR}/${ASSET}"

curl_get() {
  echo "[install] GET $1"
  curl -fsSL --retry 3 -o "$2" "$1"
}

curl_get "${BASE}/${ASSET}"                       "${BIN_PATH}"
curl_get "${BASE}/${ASSET}.sig"                   "${BIN_PATH}.sig"
curl_get "${BASE}/${ASSET}.crt"                   "${BIN_PATH}.crt"
curl_get "${BASE}/stavr-governor.sbom.cdx.json"   "${INSTALL_DIR}/stavr-governor.sbom.cdx.json"
curl_get "${BASE}/SHA256SUMS.txt"                 "${INSTALL_DIR}/SHA256SUMS.txt"

chmod +x "${BIN_PATH}"

# SHA256 cross-check
echo "[install] checking SHA256 against SHA256SUMS.txt"
EXPECTED=$(grep -E "[[:space:]]${ASSET}\$" "${INSTALL_DIR}/SHA256SUMS.txt" | awk '{print $1}' || true)
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${BIN_PATH}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${BIN_PATH}" | awk '{print $1}')
else
  echo "[install] WARN: no sha256sum / shasum available; skipping checksum step" >&2
  EXPECTED=""
  ACTUAL=""
fi
if [[ -n "${EXPECTED}" && "${EXPECTED}" != "${ACTUAL}" ]]; then
  echo "[install] FAIL: SHA256 mismatch — expected ${EXPECTED}, got ${ACTUAL}" >&2
  exit 1
fi

if [[ "${SKIP_VERIFY}" == "1" ]]; then
  echo "[install] WARNING: skipping Sigstore verification per SKIP_VERIFY=1" >&2
else
  if [[ ! -x "${SCRIPT_DIR}/verify-release.sh" ]]; then
    echo "[install] FAIL: verify-release.sh not found at ${SCRIPT_DIR}/verify-release.sh" >&2
    exit 1
  fi
  "${SCRIPT_DIR}/verify-release.sh" "${BIN_PATH}"
fi

echo ""
echo "[install] OK: ${BIN_PATH}"
echo "[install] SBOM:   ${INSTALL_DIR}/stavr-governor.sbom.cdx.json"
echo "[install] launch: ${BIN_PATH}"
