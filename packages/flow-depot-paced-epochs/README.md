# flow-depot-paced-epochs

The depot paces each outpost chain's epochs. A chain advances only once it is due: it has traffic,
its minimum has passed since its epoch start, and its traffic wait has passed since that traffic.
The flow runs Ethereum at a 60 s minimum and Solana at 30 s, each with the default traffic wait and
late window (half its minimum), nine bootstrapped batch operators in three groups of three on each
chain (a strict majority of a group's seats is two), and the economic clock at 120 s. The mock
syndication import is on, so a WIRE account holds the LIQSOL the flow desyndicates.

Each phase group shows its rules once, so a failure names the phase:

1. **IdleChainsStay** — both chains settle decided and idle after the bootstrap. Over three economic
   epochs, at least three of the longest minimum, no chain is given traffic. At every economic tick
   each chain sits at its index, decided, unpaused and without traffic (`due_at` zero). The depot
   builds no new outbound envelope (`sysio.msgch::outenvelopes`), and neither outpost's inbound
   cursor moves (Ethereum `OPPInbound.nextEpochIndex`, Solana `OutpostConfig.next_epoch_index`).
   The economic clock keeps opening epochs.
2. **TrafficMakesDue** — a holder syndicates three times on Ethereum within seconds. A strict
   majority of the seats on duty reports the outpost's backlog (`sysio.msgch::qreports`), and
   Ethereum's `traffic_since` is the oldest pending message their reports hold. Ethereum is due at
   the later of its epoch start plus 60 s and that message plus its traffic wait. It advances once,
   no sooner than due and within one relay poll, its tick and two blocks of it, while Solana does not
   move. All three syndications land in that one depot inbound epoch. A desyndication of LIQSOL then
   queues a message to Solana (`sysio.msgch::queueout`), which makes Solana due the same way. Solana
   advances once, no sooner than due and within the same slack, while Ethereum does not move. The
   Solana outpost stays PreLaunch, so it records the payout unpaid: the flow times the depot side
   only.
3. **MajorityAndLateDelivery** — kept due, Ethereum comes to a decided epoch whose next group seats
   the first batch operator, with that next epoch at least one graceful relay stop away, and the
   operator's relay is stopped. Its epoch is decided by
   two of the three seats: the depot accepts the envelope (its inbound `envlog` row) in the block of
   the second delivery, with no wait for the third. Once the next epoch opens, the relay is
   restarted. It delivers the epoch late, the accepted envelope's bytes, inside the late window
   (30 s from the next epoch's start). The advance after that closes the epoch's books, and its
   `sysio.opreg::dellog` row records the operator's delivery, not a miss.

Waits on traffic the flow creates poll without the keep-due pump. Only the last phase group, which
needs advances nothing queued would bring, keeps Ethereum due (`EpochAdvanceSteps.pollUntilKeepingDue`).

Covered elsewhere, so not repeated here:

- A withdrawal released on a chain whose current epoch is decided, with its index short of the
  request's: `flow-economic-clock` (WithdrawalWaitsOnBothClocks).
- A dispute opened by the delivery after which no version can win, pausing that chain alone, with
  the losers slashed when Tier-1 resolves it and the resolution's traffic advancing the chain:
  `flow-batch-operator-slashing`. That a split which a silent member could still decide opens no
  dispute is covered by wire-sysio's contract tests.

## Timing

Waits derive from `ProtocolTiming` and the chain waited on: one Ethereum epoch is at most 60 + 30 s,
one Solana epoch 30 + 30 s, one economic epoch 120 + 30 s.

| Phase group | Typical | Longest Step ceiling |
| --- | --- | --- |
| IdleChainsStay | 5-6 min (three economic epochs) | 630 s (the idle window) |
| TrafficMakesDue | 2-3 min (a burst, an advance on it, a desyndication and an advance on it) | 300 s (the decided-and-idle await) |
| MajorityAndLateDelivery | 4-6 min (up to three advances to seat the member, then three more) | 390 s (the member's next-on-duty await) |

With the bootstrap the flow takes about 20 minutes.

## Running

```bash
node scripts/run-flow.mjs flow-depot-paced-epochs \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

No chain is held on purpose, so the monitor runs without `--expect-epoch-freeze`. Between waits
both chains are idle, which the monitor marks `i` and never treats as a stall.

`pnpm run test:unit` runs the plan-structure tests and every check against fixture readings; it
never starts a cluster.
