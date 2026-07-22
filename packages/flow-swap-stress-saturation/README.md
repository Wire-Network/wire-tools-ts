# Fresh Swap Stress Integrity Runbook

This is the operator gate for the env-gated local-cluster suite in
`tests/SwapStressSaturation.test.ts`. It starts a new cluster, runs exactly two
real tests, and accepts success only when the independently verified evidence is
saturated. It does not change CI or attach to an existing cluster.

Run every block from `r/wire-tools-ts`. The defaults below are the platform
workspace paths. Change only `WORKSPACE` when the workspace lives elsewhere.

## Preflight

This block records every assertion in `final-f3-preflight.txt`, then stops at
the first missing or invalid prerequisite with `[blocked]`. It checks a wasm and
ABI only as a pair from one directory, so a wasm from the primary path cannot be
combined with an ABI from the fallback path. The harness resolves `anvil` and
`solana-test-validator` through `PATH`; the two supported local install
directories are added before the lookup.

```bash
set -u -o pipefail

WORKSPACE=/home/chuy/devel/wire-platform-build-system
ATTEMPT_DIR="$WORKSPACE/.omo/evidence/opp-stress-evidence-integrity"
WIRE_BUILD_PATH="$WORKSPACE/r/wire-sysio/build/release"
WIRE_ETH_PATH="$WORKSPACE/r/wire-ethereum"
WIRE_SOLANA_PATH="$WORKSPACE/r/wire-solana"
export PATH="$HOME/.foundry/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

mkdir -p "$ATTEMPT_DIR"
{
  blocked() { printf '[blocked] %s\n' "$*" >&2; exit 2; }
  require_exec() { [ -x "$1" ] || blocked "missing executable: $1"; printf 'resolved executable: %s\n' "$1"; }
  require_file() { [ -s "$1" ] || blocked "missing or empty file: $1"; printf 'resolved file: %s\n' "$1"; }
  require_json() { require_file "$1"; jq -e . "$1" >/dev/null || blocked "invalid JSON: $1"; printf 'parsed JSON: %s\n' "$1"; }
  resolve_pair() {
    name="$1"
    shift
    selected=
    for directory in "$@"; do
      wasm="$directory/$name.wasm"
      abi="$directory/$name.abi"
      if [ -s "$wasm" ] && [ -s "$abi" ] && jq -e . "$abi" >/dev/null; then
        selected="$directory"
        break
      fi
    done
    [ -n "$selected" ] || blocked "missing, empty, malformed, or split wasm/abi pair for $name"
    printf 'resolved pair: %s %s/%s.{wasm,abi}\n' "$name" "$selected" "$name"
  }

  [ -d "$WIRE_BUILD_PATH" ] || blocked "missing WIRE_BUILD_PATH: $WIRE_BUILD_PATH"
  for tool in nodeop kiod clio sys-util; do require_exec "$WIRE_BUILD_PATH/bin/$tool"; done

  for name in sysio.bios sysio.system sysio.roa sysio.token sysio.authex sysio.msig sysio.wrap; do
    resolve_pair "$name" "$WIRE_BUILD_PATH/contracts/$name" "$WIRE_BUILD_PATH/libraries/testing/contracts/$name"
  done
  for name in sysio.chains sysio.tokens sysio.epoch sysio.opreg sysio.msgch sysio.uwrit sysio.reserv sysio.chalg sysio.dclaim; do
    resolve_pair "$name" "$WIRE_BUILD_PATH/contracts/$name"
  done

  require_file "$WIRE_ETH_PATH/hardhat.config.ts"
  require_file "$WIRE_ETH_PATH/src/scripts/deployLocal.ts"
  require_exec "$WIRE_ETH_PATH/node_modules/.bin/hardhat"
  command -v npx >/dev/null || blocked 'npx is not on PATH'
  printf 'resolved executable: %s\n' "$(command -v npx)"

  require_json "$WIRE_SOLANA_PATH/wallets/opp-outpost-keypair.json"
  require_json "$WIRE_SOLANA_PATH/target/idl/opp_outpost.json"
  require_file "$WIRE_SOLANA_PATH/target/deploy/opp_outpost.so"
  command -v anvil >/dev/null || blocked 'anvil is not on PATH'
  printf 'resolved executable: %s\n' "$(command -v anvil)"
  command -v solana-test-validator >/dev/null || blocked 'solana-test-validator is not on PATH'
  printf 'resolved executable: %s\n' "$(command -v solana-test-validator)"

  printf 'PREFLIGHT=PASS\n'
} 2>&1 | tee "$ATTEMPT_DIR/final-f3-preflight.txt"
```

Do not run Jest after `[blocked]`. Build or install the named dependency, rerun
this block, and proceed only after its sole summary is `PREFLIGHT=PASS`.

## Fresh-Cluster Gate

The preflight variables remain in the shell. This creates a new cluster path,
requires its external evidence sibling to be absent, and clears
`WIRE_CLUSTER_CONFIG` so the suite cannot attach to an old cluster.

```bash
set -euo pipefail

unset WIRE_CLUSTER_CONFIG
CLUSTER_PATH=$(mktemp -d /tmp/wire-swap-stress-integrity-XXXXXX)
EVIDENCE_ROOT="${CLUSTER_PATH}-swap-stress-evidence"
[ ! -e "$EVIDENCE_ROOT" ] || { printf '[blocked] stale evidence root: %s\n' "$EVIDENCE_ROOT" >&2; exit 2; }

export WIRE_BUILD_PATH WIRE_ETH_PATH WIRE_SOLANA_PATH
export WIRE_CLUSTER_PATH="$CLUSTER_PATH"

pnpm --filter @wireio/test-flow-swap-stress-saturation exec jest tests/SwapStressSaturation.test.ts --runInBand --no-cache --json --outputFile="$ATTEMPT_DIR/final-f3-jest.json"

jq -e '
  .numTotalTests == 2 and
  .numPassedTests == 2 and
  .numFailedTests == 0 and
  .numPendingTests == 0 and
  .numTodoTests == 0 and
  .numPendingTestSuites == 0 and
  .numRuntimeErrorTestSuites == 0 and
  .numTotalTestSuites == .numPassedTestSuites and
  ([.testResults[] | select(
    .numFailingTests != 0 or .numPendingTests != 0 or .numTodoTests != 0 or .numPassingTests == 0
  )] | length) == 0
' "$ATTEMPT_DIR/final-f3-jest.json" >/dev/null

shopt -s nullglob
RUNS=("$EVIDENCE_ROOT"/runs/*)
[ "${#RUNS[@]}" -eq 1 ] && [ -d "${RUNS[0]}" ] || {
  printf '[blocked] expected exactly one new evidence run under %s/runs, found %s\n' "$EVIDENCE_ROOT" "${#RUNS[@]}" >&2
  exit 2
}
RUN_DIR="${RUNS[0]}"

pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs "$RUN_DIR" --json | tee "$ATTEMPT_DIR/final-f3-verifier.json"
jq -e '
  .valid == true and
  .verifiedSaturated == true and
  .verdict == "verified_saturated" and
  (.issues | length) == 0 and
  (.recomputedEndpoints | length) == 2 and
  all(.recomputedEndpoints[]; .saturated == true) and
  (.recomputedIterations | length) > 0 and
  (.recomputedIterations[-1].missingEndpoints | length) == 0
' "$ATTEMPT_DIR/final-f3-verifier.json" >/dev/null

printf 'F3=PASS run=%s\n' "$RUN_DIR"
```

The Jest JSON and verifier JSON are the permanent run receipts. The evidence
layout is `${CLUSTER_PATH}-swap-stress-evidence/runs/<uuid>/`, separate from the
cluster, and contains `manifest.json`, `setup.json`, `iterations/`,
`terminal.json`, `cluster-config.snapshot.json`, and immutable
`artifacts/opp/*.data` and `*.metadata` pairs.

On a Jest failure, a skipped or pending result, a multiple-run result, or a
verifier failure, preserve both `$CLUSTER_PATH` and `$EVIDENCE_ROOT` for
inspection. Do not remove either path. Only after `F3=PASS` may the operator
remove both paths:

```bash
rm -rf "$CLUSTER_PATH" "$EVIDENCE_ROOT"
```
