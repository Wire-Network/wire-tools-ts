# flow-ethereum-go-live

The pre-launch Ethereum outpost taken live, end to end, on a cluster whose
depot is bootstrapped from it:

1. The bootstrap (`ethereumDeployment: ladder`) runs wire-ethereum's
   `deployLadder.ts` — the liqEth and outpost ladders as mainnet climbed them —
   uses the pre-launch set as its users did (stakes, pretoken purchases,
   yield, the last sync), runs the real deep-freeze script, reads the frozen
   OPP stream through `capital-index/opp` and imports it into the depot during
   epoch zero (`regliqpool`, `importsynd` per staker, `importseed`), then runs
   the real go-live script before the operator daemons start.
2. The flow then verifies the reconciliation the launch depends on — the
   pool's seeded principal, the depot's outstanding and the booked figure all
   agree, every imported position is parked against its staker's pubkey — and
   sweeps one: the staker's WIRE account is provisioned, its Ethereum key is
   linked through `sysio.authex`, and the parked credit lands as the account's
   LIQETH balance.

Run it through the canonical scripts (`scripts/run-flow.mjs` +
`scripts/flow-heartbeat-monitor.mjs`); it needs the sibling `capital-index`
checkout linked by `pnpm install`.
