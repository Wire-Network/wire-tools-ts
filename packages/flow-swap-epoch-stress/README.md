# flow-swap-epoch-stress

Manual-only FlowScenario for concurrent swap settlement and post-load epoch
liveness. It multiplies the existing Ethereum-to-Solana half of
`flow-swap-with-underwriting` without encoding any one incident as the test's
expected outcome:

- 10 distinct prefunded Ethereum actors submit `requestSwap` concurrently.
- Each actor targets a different Solana recipient.
- The cluster bootstraps 21 producer accounts and 21 batch operators.
- One real underwriter is bonded on Ethereum and Solana.
- The flow evaluates actor provisioning, all 10 request submissions, UWREQ
  ingestion and confirmation, all 10 destination payouts, 15 post-load WIRE
  epoch advances, and high-confidence chain-runtime failure evidence.
- Runtime evidence includes fatal process failures, Solana program panics, and
  memory/heap failures. These are supporting causes, not the test's design axis.
  The scanner checks both committed Solana transactions and the raw aggregate
  cluster log because an RPC simulation failure has no transaction signature.
- The soak crosses the ten-epoch envelope-retention and underwriting-lock
  windows, then observes five additional epochs.

Every transaction is its own Step and uses the harness's normal fail-fast
execution. After all 10 source requests are submitted, one terminal diagnostic
step observes UWREQs, payouts, epochs, and bounded runtime evidence without
duplicating those reads across separate phases. Its outcome is either
`SWAP_EPOCH_STRESS_COMPLETED` or `SWAP_EPOCH_STRESS_FAILED`, with every observed
protocol-side invariant reported together. Provisioning or transaction-submit
failures stop at their exact failed Step.

## Run locally

Build the required sibling repositories, then use the canonical runner and
heartbeat monitor in separate terminals:

```bash
node scripts/run-flow.mjs flow-swap-epoch-stress \
  --cluster-path /tmp/wire-flow-swap-epoch-stress \
  --wire-build-path ../wire-sysio/build/debug \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana
```

```bash
node scripts/flow-heartbeat-monitor.mjs \
  --cluster-path /tmp/wire-flow-swap-epoch-stress
```

This is a long-running flow and is excluded from the default E2E suite. A
missing epoch advance fails after three extension-inclusive epoch windows
instead of waiting for the full run ceiling. Run it on demand when validating
Solana terminal, validator, OPP, or epoch-liveness changes. Reports are written
beneath `/tmp/wire-flow-swap-epoch-stress/reports/`; cluster logs and OPP
debugging artifacts remain in the same cluster directory.

The separate `wire-cluster-tool readiness` command remains the read-only tool
for inspecting an already-running SIM2 cluster; this flow owns and stresses a
fresh local cluster for reproducible debugging.
