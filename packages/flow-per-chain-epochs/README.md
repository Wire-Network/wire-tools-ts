# flow-per-chain-epochs

Each outpost chain runs its own depot-paced consensus epoch on the depot: its own
`sysio.epoch::epochcfg` and `epochstate` row, its own minimum duration, counter and schedule window,
the batch operators that joined it (`sysio.opreg::servchains`), and its own pause. A chain advances
only once it is due: it has traffic and its minimum has passed since the later of its epoch start and
that traffic. The flow runs Ethereum at a 60 s minimum and Solana at 150 s (`outpostEpochDurationSec`)
with nine bootstrapped batch operators in three groups of three on each chain, and the economic clock
at 120 s.

The flow queues nothing to either outpost, so both chains sit idle between its waits. Every wait that
needs a chain to advance keeps that chain due with keep-due traffic: the keep-due pump
(`EpochAdvanceSteps.pollUntilKeepingDue`) pushes `sysio.epoch::notetraffic` for the chain whenever it
is idle. That traffic is what drives both chains' epochs in this flow.

Each phase group asserts its own claim, so a failure names the phase:

1. **OwnMinimum** — each chain's `epochcfg` carries its own minimum, every chain's `epochstate` is
   idle (no `traffic_since`, no `due_at`) or due exactly one minimum after the later of its epoch
   start and its traffic, and the two minimums differ. Over an 840 s window on the depot head, with
   both chains kept due, each chain stays unpaused, closes at least `floor(window / (minimum + 30 s))`
   epochs and at most `floor(window / minimum) + 1`, its epochs start at least one of its minimums
   apart (`start(to) - start(from) >= (to - from) × minimum`; an advance opens the next epoch at its
   own time, never on a grid), and Ethereum advances more often than Solana (at least 9 against at
   most 6). The window leaves Ethereum's lower bound about two epochs under its worst real count: a
   kept-due 60 s epoch really closes within about 73 s (the keep-due pump's latency, the relay's
   `chkcons` poll and a block on top of the minimum).
2. **ServesOneChain** — a non-bootstrapped batch operator (`chainop`) is provisioned with
   `servedChains: [ETHEREUM]`, so its provisioning phase runs one `joinchain`. Its relay starts,
   it bonds 2 WIRE against the flow's 1 WIRE minimum and turns `ACTIVE`. Its only membership is
   `SERVING` on Ethereum. Ethereum's window seats it (non-bootstrapped operators are seated first)
   while Solana's never does. Its `sysio.system::batchduty` row on Ethereum (rows are keyed by
   operator and chain), credited by the advance that closes each seat's books one epoch after the
   seat, holds exactly its seats × the 60 s minimum (a duty epoch credits the minimum however long
   it ran), and no other chain's row of it accrues in that pay period.
3. **LeavesOneChain** — it joins Solana (`SERVING` on both) and Solana's window seats it. It then
   leaves Ethereum: the membership is `LEFT`, its resident Ethereum seat closes, no new Ethereum
   group seats it through a full rotation (four Ethereum epochs, Ethereum kept due), and Solana seats
   it in a group appended after the leave. In a pay period that opens after the books of its last
   Ethereum seat closed, its Solana row holds its seats × the 150 s minimum and its Ethereum row
   accrues nothing.
4. **PausesOneChain** — a second non-bootstrapped operator (`solwithdraw`) joins Solana only and
   bonds 0.5 WIRE, below the minimum, so it stays `UNKNOWN` and no schedule seats it. Governance
   pauses Ethereum (`sysio.epoch::pause`, signed `sysio.chalg@active`, as an open dispute on
   Ethereum does). The operator withdraws 0.25 WIRE: the queue row's `consensus_waits` name Solana
   alone, two Solana epochs past the request (a wait that also passes once Solana's current epoch is
   decided). Solana, kept due, advances those two epochs under the pause, within its minimum's bounds,
   and the request matures into `remitclaims{solwithdraw, WIRE}` while Ethereum is still paused.
   Ethereum stayed paused at one index while the economic clock kept opening epochs. After `unpause`
   Ethereum, given traffic, advances again.

The flow sets `terminateMaxPercentMisses24h` to its ceiling (99): it observes membership, not
eviction, and at the ceiling the percent rail can breach only when every seat was missed, a run the
consecutive rail evicts first. A single missed first seat while `chainop`'s relay syncs stays inside
the default 20-duty sample (`terminate_min_pct_samples`) before the percent rail applies.

## Timing

Waits derive from `ProtocolTiming` and the chain waited on, counted from the traffic the wait gives
it: one Ethereum epoch is at most 60 + 30 s, one Solana epoch 150 + 30 s, one economic epoch
120 + 30 s.

| Phase group | Typical | Longest Step ceiling |
| --- | --- | --- |
| OwnMinimum | 14 min (the 840 s window) | 900 s (the window await) |
| ServesOneChain | 7-11 min (provision, relay start, first seat and the advance that credits its duty) | 630 s (the seat-seconds await) |
| LeavesOneChain | 17-23 min (a Solana seat, a full Ethereum rotation, a Solana duty period) | 1080 s (the Solana seat-seconds await) |
| PausesOneChain | 9-12 min (two Solana epochs kept due, then two economic epochs, under the pause) | 750 s (the remit-claim verify) |

With the bootstrap the flow takes about 77 minutes.

## Running

```bash
node scripts/run-flow.mjs flow-per-chain-epochs \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path> --expect-epoch-freeze
```

The last phase group pauses Ethereum for about ten minutes on purpose, so arm the monitor with
`--expect-epoch-freeze`: a paused chain that has traffic is due but cannot advance. While it is
paused the elected operators' Ethereum `chkcons` is refused with `epoch advancement is paused`;
Solana, kept due, keeps advancing. Between waits both chains are idle, which the monitor marks `i`
and never treats as a stall.

`pnpm run test:unit` runs the plan-structure tests and every check against fixture readings; it
never starts a cluster.
