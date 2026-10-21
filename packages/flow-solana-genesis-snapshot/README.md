# Solana genesis snapshot flow

This flow invokes **capital-index's actual standalone genesis exporter** against
the local Solana outpost. It does not import the indexer's decoder/calculator,
substitute a harness implementation, or write synthetic balances into accounts.

The fixture executes real `sol_to_liqsol` deposits, two prelaunch syndications,
a direct pretoken purchase, two pool-yield purchases in distinct epochs, one
user's on-chain yield finalization, and the other user's full withdrawal. All
write and process operations are separate Report Steps. The expected earned
pretokens use the two controlled, constant principal ratios and each observed
real pool purchase delta, independently floored per round.

It verifies that:

- The genesis command refuses PreLaunch and creates no artifact.
- After the Launching transaction is finalized, the first export runs
  immediately, with **no epoch wait** between the freeze and export.
- The first export must still be in the terminal purchase's epoch. The local
  validator uses 256-slot epochs to leave room for transaction finality;
  crossing the boundary before that first export fails the test instead of
  masking a missing-tail bug.
- The export includes the terminal unmaterialized yield, adds direct and earned
  pretokens exactly once, and retains the zero-principal user's earned balance.
- Wallet records are unique, the pool's aggregate record is excluded, ownerless
  shares survive the full exit, and actual custody backs the reported
  allocations.
- The allocation hash authenticates those exact wallet records.
- A second export in a later finalized Solana epoch has identical balances and
  allocation hash. The later clock/evidence is permitted to change.

The epoch waits **before** Launching set up the two real reward rounds and prove
the already-materialized case. The wait **after** the first export tests
determinism. Neither is a prerequisite of the immediate genesis export.

## Prerequisites

The shared fresh-deployment bootstrap needs wire-ethereum's `SyndicationPool`
and an envelope ABI compatible with the WIRE runtime. An older `next` checkout
without `SyndicationPool` is insufficient. The wire-ethereum #216 → #229 go-live
stack uses whole-envelope delivery and needs the corresponding WIRE runtime; a
runtime expecting `discardEnvelopeChunks` and `envelopeChunkState` needs the
earlier chunked-envelope contracts instead. Install wire-ethereum's locked
dependencies with `npm ci`. This Solana flow uses the fresh Ethereum deployment
path and can run independently of the Ethereum ladder bootstrap. Build wire-tools-ts
with Node >=24.9 and pnpm:

```bash
pnpm build
pnpm --filter @wireio/debugging-server build
```

The second command creates the server bundle copied into the live cluster; the
root TypeScript build alone does not create it.

Build the capital-index checkout containing the Solana genesis fixes:

```bash
cd /path/to/capital-index
npm ci
npm run prisma:generate
npm run build
```

No capital-index server, database or API credentials are needed by the flow. The
child process receives the cluster's registry-issued RPC endpoint and actual
program/global-state addresses. An installed but unbuilt exporter fails the
scenario's prerequisite check.

Use wire-solana `next` with its **local development oracle** enabled:

```bash
cd /path/to/wire-solana
bash bash-scripts/reset-local-cluster.sh --build-only --features development --arch v3
```

Select the Solana/Anchor versions pinned by that checkout before
building/running. The normal production build requires the real Chainlink
accounts and cannot initialize a local tranche. The documented `development`
build supplies the deterministic $100 oracle while executing the real accounting
instructions. This flow does not validate the production Chainlink integration
or use development reset instructions. It leaves the local outpost in Launching;
it does not flip PostLaunch or submit a depot genesis import.

## Run

From wire-tools-ts, use the canonical runner and arm its canonical heartbeat
monitor in a second terminal:

```bash
WIRE_CAPITAL_INDEX_PATH=/path/to/capital-index \
node scripts/run-flow.mjs flow-solana-genesis-snapshot \
  --cluster-path /tmp/wire-solana-genesis-flow \
  --wire-build-path /path/to/wire-sysio/build/release \
  --ethereum-path /path/to/wire-ethereum \
  --solana-path /path/to/wire-solana
```

```bash
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-solana-genesis-flow
```

Use a new cluster path for each live attempt: Launching is a one-way gate.
Artifacts are saved below
`<cluster>/data/solana-genesis-snapshot/{genesis-immediate,genesis-later-epoch}.json`.
The shared bootstrap still starts both outposts and the WIRE depot; the
assertions in this flow target Solana and capital-index.

Unit checks, including failure cases for the exported artifact and external
process wiring, run with:

```bash
pnpm build
pnpm --filter @wireio/test-flow-solana-genesis-snapshot test:unit
```

The root `pnpm test:ci` also discovers this package's `test:unit` script. The
live flow is discovered automatically by the canonical runner/e2e gate.

## Verified local run

On 2026-10-20 the live flow passed against wire-solana `f36808e` (`next`,
development oracle), wire-ethereum `97f1fd8` (chunked-envelope contracts), and
the installed WIRE runtime reporting `02dfa26a-dirty`.

The immediate export was in the terminal purchase's epoch, **7**. The later
export was in epoch **8**. Both contained the same two wallet allocations,
reported no accounting issues, and had allocation hash
`f19cd1b1385e75b7fd5c1950f9e53a2b47220de6e5366ba44defe5351550ff0f`. The fully
withdrawn wallet retained its earned pretokens. Build, lint and all 17 flow unit
tests also passed.

Before unstacking from PR #126, full `pnpm test:ci` passed: **452 Jest suites,
4,281 tests, and every package's `test:unit` lane**. Build and lint also passed
on that combined branch; those counts describe the earlier stacked head.

The branch includes
[PR #132](https://github.com/Wire-Network/wire-tools-ts/pull/132) to keep
source-map-support registration in the debugging-server CLI instead of its
library barrel. Without it, `renderer/index.test.tsx` hung under jsdom: two full
runs reached 450 passing suites before their 30-minute limits. The same focused
command,
`NODE_OPTIONS=--experimental-vm-modules timeout -k 10 120 pnpm exec jest --selectProjects ql-tool-app --runInBand`,
also timed out on this branch and PR #126's fully built base `bfc61e99`. With
#132, that project passed all 78 suites and 544 tests in 53 seconds; full Jest
then completed in 361 seconds.

The live evidence above was captured before integrating that CI fix and before
unstacking onto `master`. The Solana flow source and its unit tests are unchanged
by those integrations. Current-head validation is recorded in the PR description.
