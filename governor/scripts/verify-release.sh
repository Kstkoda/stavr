#!/usr/bin/env bash
# verify-release.sh — operator-side verification of a signed stavR Governor
# release binary against Sigstore Rekor.
#
# Wraps `cosign verify-blob` with the identity/issuer expected for stavR
# Governor releases produced by `.github/workflows/governor-release.yml`.
#
# Per BOM v0.6.5.1 (P1) and ADR-038 §2.
#
# Usage:
#   ./verify-release.sh <path-to-binary>
#   IDENTITY_REGEXP=... OIDC_ISSUER=... ./verify-release.sh <path-to-binary>
#
# Requires cosign on PATH. Install via:
#   brew install cosign           # macOS
#   apt-get install cosign        # Debian/Ubuntu (recent versions)
#   go install github.com/sigstore/cosign/v2/cmd/cosign@latest

set -euo pipefail

BINARY_PATH="${1:-}"
IDENTITY_REGEXP="${IDENTITY_REGEXP:-https://github.com/Kstkoda/stavr/.*}"
OIDC_ISSUER="${OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

if [[ -z "${BINARY_PATH}" ]]; then
  echo "[verify-release] usage: $0 <path-to-binary>" >&2
  exit 2
fi

if [[ ! -f "${BINARY_PATH}" ]]; then
  echo "[verify-release] FAIL: binary not found: ${BINARY_PATH}" >&2
  exit 1
fi

SIG_PATH="${BINARY_PATH}.sig"
CRT_PATH="${BINARY_PATH}.crt"

for f in "${SIG_PATH}" "${CRT_PATH}"; do
  if [[ ! -f "${f}" ]]; then
    echo "[verify-release] FAIL: missing companion file: ${f}" >&2
    exit 1
  fi
done

if ! command -v cosign >/dev/null 2>&1; then
  echo "[verify-release] FAIL: cosign is not on PATH" >&2
  echo "[verify-release]   install: brew install cosign  (macOS)" >&2
  echo "[verify-release]   install: apt-get install cosign  (Debian/Ubuntu)" >&2
  exit 1
fi

echo "[verify-release] Verifying ${BINARY_PATH}"
echo "[verify-release]   identity-regexp = ${IDENTITY_REGEXP}"
echo "[verify-release]   oidc-issuer     = ${OIDC_ISSUER}"

if cosign verify-blob \
      --certificate-identity-regexp "${IDENTITY_REGEXP}" \
      --certificate-oidc-issuer "${OIDC_ISSUER}" \
      --signature "${SIG_PATH}" \
      --certificate "${CRT_PATH}" \
      "${BINARY_PATH}"; then
  echo "[verify-release] OK: signature valid (Sigstore Rekor)"
  exit 0
else
  rc=$?
  echo "[verify-release] FAIL: cosign verify-blob returned ${rc}" >&2
  exit "${rc}"
fi
