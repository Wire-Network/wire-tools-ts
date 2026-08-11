# flow-swap-epoch-stress

Manual-only FlowScenario that reproduces the swap load which exposed the
Solana terminal/epoch-stall failure. It intentionally multiplies the existing
Ethereum-to-Solana half of `flow-swap-with-underwriting`:

- 10 distinct prefunded Ethereum actors submit `requestSwap` concurrently.
- Each actor targets a different Solana recipient.
- The cluster bootstraps 21 producer accounts and 21 batch operators.
- One real underwriter is bonded on Ethereum and Solana.
- The flow verifies all 10 destination payouts, all 10 confirmed UWREQ rows,
  15 post-load WIRE epoch advances, and recent Solana outpost logs for
  memory/heap errors. The soak crosses the ten-epoch envelope-retention and
  underwriting-lock windows, then observes five additional epochs.

Every transaction is its own Step. The generated Markdown, HTML, and CSV
reports contain the parameters, transaction/RPC evidence, payout observations,
UWREQ statuses, epoch baseline/result, and relevant Solana log evidence.

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
beneath
`/tmp/wire-flow-swap-epoch-stress/reports/`; cluster logs and OPP debugging
artifacts remain in the same cluster directory.

The separate `wire-cluster-tool readiness` command remains the read-only tool
for inspecting an already-running SIM2 cluster; this flow owns and stresses a
fresh local cluster for reproducible debugging.
