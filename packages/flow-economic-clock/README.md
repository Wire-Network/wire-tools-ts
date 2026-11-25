# flow-economic-clock

`sysio.epoch` runs two kinds of clock. Each outpost chain runs its own consensus epoch (its
`epochcfg` / `epochstate` row), which advances on that outpost's consensus and stops while the chain
is paused. The one economic clock (`economycfg` / `economystate`) opens epochs on a fixed wall-clock
grid through the batch operators' `tickeconomy` crank; emissions accrue and pay, and collateral
withdrawals mature, on it. The flow runs every chain's consensus at 60 s and the economic clock at
120 s, so each chain advances about twice per economic epoch and a withdrawal's two economic epochs
(240 s) outlast its two consensus epochs of each chain (120 s).

Each phase group asserts its own claim, so a failure names the phase:

1. **ClocksIndependent** — `economycfg` and each chain's `epochcfg` row carry the resolved durations,
   every economic epoch is a pay epoch and `t5state` starts on the economic grid. Five economic epochs
   open, each at `start_time + (N - 1) × 120 s`, spanning 120 s. Between the first and the last
   (480 s) each chain's consensus advances at least `floor(window / 90 s)` epochs, and more than the
   economic clock does. Every
   economic epoch writes one `epochlog` row, with consecutive payment counts. The producer's
   `payclaims` is positive and `claimpay` pays it in full.
2. **WithdrawalWaitsOnBothClocks** — a non-bootstrapped batch operator joins every outpost chain
   (`sysio.opreg::joinchain`, `SERVING`) and bonds 2 WIRE. No collateral minimum is configured, so
   it stays `UNKNOWN`, no schedule seats it, and it needs no relay. It withdraws 0.5 WIRE as an
   economic epoch opens. The queue row's `eligible_at_economic_epoch` is two economic epochs past
   the request, and its `consensus_waits` name every chain it serves, each two of that chain's
   epochs past the request. A chain's wait passes once the chain reaches that epoch or decides its
   current epoch (its winner accepted, no dispute open on it). When every chain has passed its wait
   the row is still queued, and the remit claim is credited only once the economic wait has passed
   too. Once Ethereum's current epoch is decided at least 20 s before its boundary, governance
   pauses Ethereum (`sysio.epoch::pause(ETHEREUM)`, signed `sysio.chalg@active`) on that epoch and
   the operator withdraws again. When the economic clock reaches its field the row has already
   matured: Ethereum is still paused on its decided epoch, at its index from before the request and
   short of the request's epoch for it, and the claim holds both withdrawals. Governance then
   unpauses Ethereum.
3. **HeldEmissions** — as an economic epoch opens, `sysio`'s spendable WIRE (balance less
   `payclaimtot.outstanding` and `t5state.unsettled_batch_emission`) moves to `econ.holder`. The next
   pay epoch opens a `BALANCE_INSUFFICIENT` `blocklog` episode. `t5state` still accrues the attempted
   period total and no `epochlog` row is written. While held, the depot sends an envelope to each
   outpost and accepts its answer at the same consensus epoch of that chain (`sysio.msgch::envlog`),
   another economic epoch opens and is held, and every chain's consensus advances. After the refund the next economic epoch
   pays one `epochlog` row: everything pending after the last held epoch plus its own share. The
   episode is erased and nothing stays pending.
4. **AndonCord** — with the `sysio.andon` cord pulled, an economic epoch pays its period and the
   producer's `claimpay` pays in full. The cord is still pulled after the claim, then it is cleared.

## Timing

Waits derive from `ProtocolTiming`: one economic epoch is 120 + 30 s, one consensus epoch of either
chain 60 + 30 s.

| Phase group | Typical | Longest Step ceiling |
| --- | --- | --- |
| ClocksIndependent | 9-10 min (five economic epochs) | 930 s (the five-epoch await) |
| WithdrawalWaitsOnBothClocks | 11-13 min (two requests, about two economic epochs each) | 630 s (each remit-claim verify) |
| HeldEmissions | 6-8 min (about three economic epochs) | 450 s (the envelope round trip) |
| AndonCord | 1-3 min (one economic epoch) | 330 s (the economic-epoch await) |

With the bootstrap the flow takes about 40 minutes.

## Running

```bash
node scripts/run-flow.mjs flow-economic-clock \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path> --expect-epoch-freeze
```

The second withdrawal pauses Ethereum's consensus for about four minutes on purpose, so arm the
monitor with `--expect-epoch-freeze`. While it is paused the elected operators' Ethereum `chkcons` is
refused with `epoch advancement is paused`; Solana keeps advancing.

`pnpm run test:unit` runs the plan-structure tests and every check against fixture readings; it
never starts a cluster.
