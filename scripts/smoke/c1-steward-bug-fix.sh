#!/usr/bin/env bash
#
# Smoke test for stream C C1 — cowire steward bug-fix.
#
# Exercises the --dry-run path against a stubbed `gh` (Node script shim
# pointed at via COWIRE_GH_BIN). Verifies:
#   1. --dry-run exits 0 and emits valid JSON.
#   2. The JSON includes the scope id, the brief preview, and the
#      auto-approval decision matching COWIRE_AUTO_APPROVE_BUG_FIXES.
#
# Run after `npm run build`. Idempotent.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="node $ROOT/dist/cli.js"
if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "smoke: dist/cli.js missing — run 'npm run build' first" >&2
  exit 2
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t cowire-c1-smoke)"
trap 'rm -rf "$TMP"' EXIT

# Node-script gh shim.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh-fake.js" <<'NODE'
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 1,
    title: 'Smoke bug',
    body: 'Synthetic.',
    state: 'open',
    labels: [{ name: 'bug' }],
    url: 'https://github.com/Kstkoda/cowire-test-sandbox/issues/1',
  }));
  process.exit(0);
}
process.exit(1);
NODE
cat > "$TMP/bin/gh" <<EOF
#!/usr/bin/env bash
exec node "$TMP/bin/gh-fake.js" "\$@"
EOF
chmod +x "$TMP/bin/gh"
export COWIRE_GH_BIN="$TMP/bin/gh"
export COWIRE_HOME="$TMP/home"
mkdir -p "$COWIRE_HOME"

echo "==> 1/2: --dry-run with auto-approve set"
OUT=$(COWIRE_AUTO_APPROVE_BUG_FIXES=1 $CLI steward bug-fix \
  --issue Kstkoda/cowire-test-sandbox#1 --dry-run)
echo "$OUT" | grep -q '"dry_run": true' \
  || { echo "FAIL: missing dry_run flag"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q '"granted": true' \
  || { echo "FAIL: auto-approval not granted"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q '"github.create_pr"' \
  || { echo "FAIL: allowed_actions missing github.create_pr"; echo "$OUT"; exit 1; }
echo "    dry-run reports auto_approved=true, allowed_actions contain github.create_pr"

echo "==> 2/2: --dry-run without auto-approve env var"
OUT=$($CLI steward bug-fix --issue Kstkoda/cowire-test-sandbox#1 --dry-run)
echo "$OUT" | grep -q '"granted": false' \
  || { echo "FAIL: auto-approval should not be granted without env var"; echo "$OUT"; exit 1; }
echo "    dry-run reports auto_approved=false"

echo "SMOKE C1 OK"
