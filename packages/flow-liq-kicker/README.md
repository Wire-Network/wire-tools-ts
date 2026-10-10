# flow-liq-kicker

Exercises `sysio.kicker`, which pays LIQ holders a governance-budgeted WIRE gift for the
time since a token's last payment (wire-sysio `contracts/sysio.system/EMISSIONS.md`).
Every write is a Report Step; depot confirmations wait for irreversibility.

1. **KickerConfigured** — the bootstrap's `Kicker` and `KickerPools` phases left
   `kickcfg` at `Steps.registry.KickerConfiguration` (1,000,000 WIRE, 60 s) and LIQETH's
   pool at 200 bps with the one-WIRE minimum, having paid nothing.
2. **ManualKick** — once the chain clock passes `last_kick + min_interval_sec`, the flow
   snapshots the pool, budget, supply, the LIQETH/WIRE reserves, the yield index and the
   treasury, then pushes ONE transaction signed by `sysio`: `setpool` to a one-unit
   minimum, `kick(LIQETH)`, `setpool` back to one WIRE. Then it verifies:
   - the treasury draw in the transaction's trace equals the modelled gift,
     `floor(floor(supply × 200 × elapsed_us / (10^4 × 31,557,600 × 10^6)) × floor((wire << 64) / shadow) >> 64)`
     (`LIQKickerAccrual`, wire-sysio's `kicker_test_reference.hpp` formula);
   - `last_kick` advanced to the kick's block time (the whole interval was paid);
   - `gifted_total`, `budget_remaining`, `sysio.liq::yieldidx` (pot, index, carry) and the
     treasury net of the `sysio.ops`/`sysio.gov` buckets each moved by exactly the gift,
     and `sysio.kicker` kept nothing.
3. **CrankKick** — planned only when the cluster's `nodeop --help` lists
   `--batch-kick-crank` (the batch-operator plugin's kick crank). The flow lowers LIQETH's
   minimum to one unit, pushes no kick, and waits for a batch operator's crank to pay the
   next interval; the payment must match the same model and move the same ledgers. The
   minimum is then restored. Without the crank, a `CrankKickUnavailable` phase records
   that nothing was observed.

## Why the manual kick is one transaction

At the mock pools' 10-token supply, LIQETH accrues about 0.2 WIRE a year, so no kick ever
meets the bootstrap's one-WIRE minimum and the crank's pushes are no-ops. Lowering the
minimum, kicking and restoring it atomically means no crank can pay the interval between
the flow's snapshot and its kick, so the payment is attributable to the flow's own kick.

## Bootstrap defaults

The scenario opts into `enableMockLiqPools`: `addpool` needs each token's LIQ/WIRE yield
pool, and `regliqpool` is epoch-zero only. The kicker deploy and `setconfig` are
unconditional bootstrap phases.

## Running

```bash
# From the wire-tools-ts root:
node scripts/run-flow.mjs flow-liq-kicker \
  --cluster-path    /tmp/wire-flow-liq-kicker \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path   ../wire-ethereum \
  --solana-path     ../wire-solana

# In a second terminal — the mandatory six-probe heartbeat:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-liq-kicker
```

The `--wire-build-path` build must carry `contracts/sysio.kicker/sysio.kicker.{wasm,abi}`;
its `nodeop` decides whether the CrankKick phase runs.
