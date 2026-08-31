# Cluster readiness

Cluster readiness is a read-only preflight for a Wire depot plus its Ethereum
and Solana outposts. It answers a narrow question: do the selected live
endpoints expose the identities, liveness, protocol configuration, reserves,
collateral, and canonical quote paths required to begin swap testing?

It has two entrypoints over one implementation:

```text
flow-cluster-readiness ─┐
                       ├─ ReadinessPhaseGroups ─ Steps ─ native Report
wire-cluster-tool       ┘
  readiness
```

- `flow-cluster-readiness` bootstraps a fresh mock-reserve cluster through the
  normal `FlowScenario`/`FlowCLI` stack, then appends the readiness phases.
- `wire-cluster-tool readiness` skips provisioning and runs the same phases
  against caller-supplied endpoints. It is the path for a devbox, sandbox, or
  other already-running cluster.

## Proof boundary

The suite checks:

- explicit Wire, Ethereum, and Solana endpoint identities;
- bounded head/slot advancement and Wire head freshness;
- optional Hyperion health, only when `--hyperion-url` is supplied;
- required Wire swap-contract ABI surfaces, epoch scheduling, and active EVM and
  SVM chain-registry rows;
- underwriting configuration, active underwriter collateral after locks and
  pending withdrawals, public reserve depth, token bindings, deployed EVM
  contract or configured Solana account existence, and expired pending request
  backlog;
- every public Wire/external and cross-chain direction using the canonical
  client-side depot quote math and a small probe derived from live depth.

The verdict is deliberately **read-only preflight**, not transactional proof. It
does not submit a swap, prove daemon relay/circulation, infer success from an
old confirmed request, inspect external custody, or validate settlement. Use a
dedicated swap flow for those claims.

The suite also does not load SDK-outpost deployment profiles, query the S3
artifact handoff, consult Noco or another network catalog, or test Hub
integration. Those remain separate lanes:

```text
devbox export → S3 handoff → ETH/SOL publisher workflows → npm artifacts
                                                     ↓
                                      sdk-outpost profile registry → Hub tests
```

Cluster readiness can consume explicit endpoints produced by that deployment,
but it does not become the artifact registry or an SDK-outpost integration test.
Swap-matrix and epoch-stress scenarios remain separate transactional and stress
proofs; they can reuse these PhaseGroups later without merging their
responsibilities.

## Run against a connected cluster

Build the package, obtain the exact Wire chain ID from the intended endpoint,
then pass every endpoint explicitly:

```bash
pnpm --filter @wireio/cluster-tool build

pnpm exec wire-cluster-tool readiness \
  --wire-rpc https://api-josh.sandbox.wire-dev.com \
  --wire-chain-id <64-character-wire-chain-id> \
  --ethereum-rpc https://ethereum-josh.sandbox.wire-dev.com \
  --ethereum-chain-id 31337 \
  --solana-rpc https://solana-josh.sandbox.wire-dev.com \
  --solana-genesis-hash <optional-exact-genesis-hash> \
  --observation-ms 15000 \
  --timeout-ms 8000 \
  --report-path ./readiness-reports \
  --report-format md \
  --report-format html
```

`--wire-chain-id` is required because reaching a healthy but wrong Wire chain is
a hard failure. Ethereum chain ID and Solana genesis hash are optional
additional identity pins. URLs are recorded in reports without query strings or
fragments so credentials cannot leak through evidence.

The command exits non-zero when any blocking Step fails. Independent checks use
collect mode, so a failure still leaves later diagnostic evidence in the native
Markdown/HTML/CSV Report.

## Run as a fresh-cluster flow

Use the canonical flow runner and its normal heartbeat monitor:

```bash
node scripts/run-flow.mjs flow-cluster-readiness \
  --cluster-path /tmp/wire-flow-cluster-readiness \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana

node scripts/flow-heartbeat-monitor.mjs \
  --cluster-path /tmp/wire-flow-cluster-readiness
```

The scenario opts into mock reserves because it creates a disposable
representative swap cluster. It still uses the same `ReadinessPhaseGroups` and
native Report as the connected CLI; there is no second readiness implementation.
The heartbeat monitor is mandatory for the entire live run and uses the same
cluster path as the runner.
