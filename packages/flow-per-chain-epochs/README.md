# flow-per-chain-epochs

Each outpost chain runs its own consensus epoch on the depot: its own `sysio.epoch::epochcfg` and
`epochstate` row, its own duration, counter and schedule window, the batch operators that joined it
(`sysio.opreg::servchains`), and its own pause. The flow runs Ethereum at 60 s and Solana at 150 s
(`outpostEpochDurationSec`) with nine bootstrapped batch operators in three groups of three on each
chain, and the economic clock at 120 s.

Each phase group asserts its own claim, so a failure names the phase:

1. **OwnCadence** — each chain's `epochcfg` carries its own duration, every chain's current epoch
   spans exactly that duration, and the two durations differ. Over a 720 s window on the depot
   head each chain stays unpaused, its epochs start exactly one of its own durations apart
   (`start(to) - start(from) = (to - from) × duration`), it closes at least
   `floor(window / (duration + 30 s))` epochs, and Ethereum advances more often than Solana (at
   least 8 against at most 6).
2. **ServesOneChain** — a non-bootstrapped batch operator (`chainop`) is provisioned with
   `servedChains: [ETHEREUM]`, so its provisioning phase runs one `joinchain`. Its relay starts,
   it bonds 2 WIRE against the flow's 1 WIRE minimum and turns `ACTIVE`. Its only membership is
   `SERVING` on Ethereum. Ethereum's window seats it (non-bootstrapped operators are seated first)
   while Solana's never does. Its `sysio.system::batchduty` row on Ethereum (rows are keyed by
   operator and chain) holds a positive multiple of 60 s, and no other chain's row of it accrues in
   that pay period.
3. **LeavesOneChain** — it joins Solana (`SERVING` on both) and Solana's window seats it. It then
   leaves Ethereum: the membership is `LEFT`, its resident Ethereum seat closes, no new Ethereum
   group seats it through a full rotation (four Ethereum epochs), and Solana seats it in a group
   appended after the leave. In a pay period that opens after its last Ethereum seat closed, its
   Solana row holds a positive multiple of 150 s and its Ethereum row accrues nothing.
4. **PausesOneChain** — a second non-bootstrapped operator (`solwithdraw`) joins Solana only and
   bonds 0.5 WIRE, below the minimum, so it stays `UNKNOWN` and no schedule seats it. Governance
   pauses Ethereum (`sysio.epoch::pause`, signed `sysio.chalg@active`, as an open dispute on
   Ethereum does). The operator withdraws 0.25 WIRE: the queue row's `consensus_waits` name Solana
   alone, two Solana epochs past the request, and the request matures into
   `remitclaims{solwithdraw, WIRE}` while Ethereum is still paused. Ethereum stayed paused at one
   index while the economic clock kept opening epochs, and Solana advanced as its envelope requires
   over the same readings. After `unpause` Ethereum advances again.

The flow sets `terminateMaxPercentMisses24h` to its ceiling (99): it observes membership, not
eviction, and at the ceiling the percent rail can breach only when every seat was missed, a run the
consecutive rail evicts first. A single missed first seat while `chainop`'s relay syncs stays inside
the default 20-duty sample (`terminate_min_pct_samples`) before the percent rail applies.

## Timing

Waits derive from `ProtocolTiming` and the chain waited on: one Ethereum epoch is 60 + 30 s, one
Solana epoch 150 + 30 s, one economic epoch 120 + 30 s.

| Phase group | Typical | Longest Step ceiling |
| --- | --- | --- |
| OwnCadence | 12 min (the 720 s window) | 780 s (the window await) |
| ServesOneChain | 6-10 min (provision, relay start, first seat and its duty) | 540 s (the seat-seconds await) |
| LeavesOneChain | 15-20 min (a Solana seat, a full Ethereum rotation, a Solana duty period) | 930 s (the first Solana seat await) |
| PausesOneChain | 8-10 min (two economic epochs and two Solana epochs under the pause) | 750 s (the remit-claim verify) |

With the bootstrap the flow takes about 70 minutes.

## Running

```bash
node scripts/run-flow.mjs flow-per-chain-epochs \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path> --expect-epoch-freeze
```

The last phase group pauses Ethereum for about eight minutes on purpose, so arm the monitor with
`--expect-epoch-freeze`. While it is paused the elected operators' Ethereum `chkcons` is refused
with `epoch advancement is paused`; Solana keeps advancing.

`pnpm run test:unit` runs the plan-structure tests and every check against fixture readings; it
never starts a cluster.
