# flow-batch-operator-slashing

Three SBP-less batch operators join the Ethereum outpost chain only and are flipped ACTIVE. The flow
does not rebuild any schedule. Every chain's window holds two groups of three, and each advance draws
the new tail group from the chain's ACTIVE, serving batch operators outside the group still seated,
non-bootstrapped first. So Ethereum's next advance seats the three as its tail group, and the advance
after makes them its only active group. Epochs are depot-paced: a chain advances only once it is due
(it has traffic and its minimum has passed), and an idle chain never advances. The flips start only
while Ethereum is idle or at least half a minimum short of its `due_at`, so that all three land before
the same advance; idle means no straddle. An advance between two flips would seat a mixed tail, and
the dispute operators in it would miss that epoch instead of owning it alone. The flow queues nothing
to Ethereum, so the await for those two advances gives Ethereum keep-due traffic
(`sysio.epoch::notetraffic`, through the keep-due pump) until the three are on duty. The flow runs
every miss rail at its loosest valid setting
(`terminateMaxConsecutiveMisses` 5, `terminateMaxPercentMisses24h` 99,
`terminateMinimumPercentSamples` 100), so the dispute operators are not evicted before the slash.

Nothing delivers for the new epoch, so it stays undecided and Ethereum freezes on it with an empty
envelope bucket, which the flow verifies. The three then deliver three different envelopes for it. The third leaves no
version able to win, so its `sysio.msgch::evalcons` opens a dispute and `sysio.chalg::opendispute`
pauses the Ethereum consensus epoch alone: the Solana chain's schedule keeps the bootstrapped
operators, which keep it advancing whenever it has traffic. Three of the four Tier-1 node owners vote the canonical
checksum, and the bootstrapped batch operators' `chkdispute` crank resolves the dispute and lifts
the pause. The resolution's acceptance of the winner slashes the two non-canonical deliverers in
that transaction, while Ethereum still sits at the contested epoch. The canonical deliverer is not
slashed.

The resolution records Ethereum's traffic (`sysio.msgch::resolvedisp`), so Ethereum falls due one
traffic wait later, but its group is still the three dispute operators, which run no relay, so no
elected operator cranks it. The **ContestedChainAdvances** phase records the SLASHED operators, waits
for Ethereum to fall due, and pushes `sysio.msgch::chkcons` itself, unless a relay serving Ethereum
already pushed it for liveness (one minimum after it falls due). Ethereum advances past the contested
epoch, and that advance slashes no one new: no operator is SLASHED that was not before it, the
losers stay SLASHED from the resolution and the canonical deliverer stays unslashed. The flow ends
there and leaves the Ethereum outpost on the contested epoch: no relay of that epoch's group
delivers its depot envelope, so the next epoch is never decided. The advance after it, which would
close the contested epoch's own books, cannot happen in this flow; that it slashes nothing is
covered by the wire-sysio contract tests.

While the dispute is open, the **EconomicClockDuringDispute** group checks that the pause holds the
Ethereum consensus only. An economic epoch opens on the bootstrapped relays' `tickeconomy` crank
while Ethereum stays paused at the contested epoch. Every relay is then stopped and restarted
against its retained data. The restarted relays catch the economic clock up with its grid and open
another economic epoch, and Ethereum is still paused at the same epoch. The relays restart before the
vote, so their crank still resolves the dispute.

## Running

```bash
node scripts/run-flow.mjs flow-batch-operator-slashing \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path> --expect-epoch-freeze
```

The flow holds the contested Ethereum epoch on purpose (a paused or undecided chain that has traffic
is due but cannot advance), so arm the monitor with `--expect-epoch-freeze`.
`pnpm run test:unit` checks the plan's structure, and the jest suites cover the envelope codec and
the inbound tip reader; neither starts a cluster.
