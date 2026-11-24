# flow-batch-operator-slashing

Three SBP-less batch operators become the only active group and deliver three different envelopes for
one outpost and epoch, past the epoch boundary. `sysio.msgch::evalcons` opens a dispute and
`sysio.chalg::opendispute` pauses the consensus epoch. Three of the four Tier-1 node owners vote the
canonical checksum, the bootstrapped batch operators' `chkdispute` crank resolves the dispute and
lifts the pause, and the next `advance` slashes the two non-canonical deliverers. The canonical
deliverer is not slashed.

While the dispute is open, the **EconomicClockDuringDispute** group checks that the pause holds
consensus only. An economic epoch opens on the bootstrapped relays' `tickeconomy` crank while
consensus stays paused at the contested epoch. Every relay is then stopped and restarted against
its retained data. The restarted relays catch the economic clock up with its grid and open another
economic epoch, and consensus is still paused at the same epoch. The relays restart before the vote,
so their crank still resolves the dispute.

## Running

```bash
node scripts/run-flow.mjs flow-batch-operator-slashing \
  --cluster-path    <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path> --expect-epoch-freeze
```

The flow holds the contested epoch on purpose, so arm the monitor with `--expect-epoch-freeze`.
`pnpm run test:unit` checks the plan's structure, and the jest suites cover the envelope codec and
the inbound tip reader; neither starts a cluster.
