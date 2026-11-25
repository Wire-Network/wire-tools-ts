# flow-batch-operator-slashing

Three SBP-less batch operators join the Ethereum outpost chain only and are flipped ACTIVE. The flow
does not rebuild any schedule. Every chain's window holds one group of three, and each advance draws
the next epoch's group from the chain's ACTIVE, serving batch operators, non-bootstrapped first. So
Ethereum's next advance makes the three its only active group. The flips start only when at least
half an epoch is left before Ethereum's next boundary, so that all three land before the same advance.
An advance between two flips would seat a mixed group, and the dispute operators in it would miss
that epoch instead of owning it alone. The flow runs every miss rail at its loosest valid setting
(`terminateMaxConsecutiveMisses` 5, `terminateMaxPercentMisses24h` 99,
`terminateMinimumPercentSamples` 100), so the dispute operators are not evicted before the slash.

Nothing delivers for the new epoch, so Ethereum freezes on it with an empty envelope bucket, which
the flow verifies. The three then deliver three different envelopes for it. The third leaves no
version able to win, so its `sysio.msgch::evalcons` opens a dispute and `sysio.chalg::opendispute`
pauses the Ethereum consensus epoch alone: the Solana chain's schedule keeps the bootstrapped
operators, which keep it advancing. Three of the four Tier-1 node owners vote the canonical
checksum, and the bootstrapped batch operators' `chkdispute` crank resolves the dispute and lifts
the pause. The resolution's acceptance of the winner slashes the two non-canonical deliverers in
that transaction, while Ethereum still sits at the contested epoch. The canonical deliverer is not
slashed.

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

The flow holds the contested Ethereum epoch on purpose, so arm the monitor with `--expect-epoch-freeze`.
`pnpm run test:unit` checks the plan's structure, and the jest suites cover the envelope codec and
the inbound tip reader; neither starts a cluster.
