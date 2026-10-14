# flow-liq-kicker

Exercises `sysio.kicker`, which pays LIQ holders a governance-budgeted WIRE gift for the
time since a token's last payment (wire-sysio `contracts/sysio.system/EMISSIONS.md`).
Every write is a Report Step; depot confirmations wait for irreversibility.

1. **KickerConfigured** verifies the bootstrap's 1,000,000-WIRE budget, 60-second
   minimum interval, 86,400-second TWAP window, 200-bps rate and mandatory daily
   ceiling of 1,000 WIRE.
2. **KickerFlowWindow / KickerValidation** sets the window to the 60-second floor.
   Named transactions exercise all five kicker actions, unauthorized governance,
   invalid windows/intervals/budgets/rates/minima/caps, duplicate and unknown pools,
   removal/re-addition, warm-up, minimum-interval and below-minimum skips, Andon
   hold, budget and treasury shortfalls, zero supply, and transaction/inline rollback.
   The warm-up probe uses a one-second interval and a day-long window, so it tests
   the TWAP gate independently of the interval gate; it restores both settings.
   Treasury-reservation/restore and shadow-burn/restore probes are atomic. The
   reservation raises the remaining emission ceiling without transferring a sampled
   balance; concurrent payepoch cannot overdraw it. Treasury plus category-bucket
   holdings, kicker holdings and emission configuration are checked after restoration.
   The zero-supply probe runs with a one-second minimum before the shared funding
   and manual-payment window matures, then restores the original interval. Skips and
   failures preserve the payment and price clocks; funding shortfalls record the
   exact TWAP-priced unpaid gift. No probe exposes its temporary state to an epoch.
3. **ManualKick** uses the matured funding window, snapshots the state, then atomically lowers
   the minimum, kicks under `sysio.kicker@active` (a permissionless keeper), and
   restores the minimum under `sysio@active`. The oracle uses
   `(after.price_snapshot - before.price_snapshot) / (after.price_time - before.price_time)`
   as Q64.64 TWAP. It floors accrual and conversion independently, bounds catch-up
   to 72 hours, and checks the treasury, budget, pool total and yield-index ledgers.
   The trace must contain no system-emissions action or WIRE issuance.
4. **CrankKick** probes `nodeop --help` in a cancellable Report Step. A failed
   process fails the report; successful help without `--batch-kick-crank` records
   unavailable coverage. With a crank, the flow re-adds the pool and gives it a
   one-unit daily cap **and** one-unit budget, permitting exactly one partial
   payment even across UTC midnight. A structured trace is accepted only after its
   transaction is located in an irreversible block that contains the same id and
   execution time. The oracle extends swap's cumulative price to that execution
   time, checks the partial clock and all ledgers, then restores the pool and the
   original budget less all paid units. Before restoring, one atomic transaction
   gives a first kick a one-unit budget to re-exhaust the cap if UTC midnight passed,
   then gives a second kick a positive budget to probe the exhausted cap and restores
   zero budget. Both kicks share the execution time, so rollover during submission
   cannot leave the probe on a stale day. Any recovery payment, partial clock and
   yield ledgers are checked and deducted from the restored budget. No wait is added.
   The plugin's scan pages at most 10 pools per
   poll; these two fixture pools fit in one page.

The jest tests verify orchestration and the independent oracle. They do not execute
WASM. The final sysio #675 contract suite separately covers UTC rollover, overflow,
exhausted/missing emissions configuration, multi-token policies and long outages;
those require a controlled contract-test clock/state and are not copied into this
short live flow.

The two fresh payment-clock windows introduce up to **120 seconds of required
chain maturity** (less wall-clock waiting when transaction finality overlaps them).
One 60-second window serves the funding shortfalls and manual payment; zero supply
runs before it with its own one-second interval gate. The isolated crank needs the
second 60-second window. The funding wait has a 150-second inner budget
(`60 + effectiveEpochSec(60) = 150`); the crank observation has a 360-second budget,
including its window, keeper spacing/poll and finality. Their aggregate inner ceiling
is **510 seconds**, plus transaction/RPC work. Poll deadlines scale only with the
explicit `WIRE_FLOW_TIMEOUT_SCALE` (1–5), giving 510–2,550 seconds; step ceilings
include `ProtocolTiming.PollDeadlineBufferMs`. No live timing was measured.

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
