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
- A direct purchase invokes the oracle for round data and decimals through the
  production Chainlink client. A development-feature outpost fails this check.
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
- The initial-chain allocation limit equals purchased principal. Extra custody
  from converted yield or donations does not increase the settlement ledger.
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
path and can run independently of the Ethereum ladder bootstrap. Build
wire-tools-ts with Node >=24.9 and pnpm:

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

Build wire-solana `next` with its pinned toolchain and the normal program
features:

```bash
cd /path/to/wire-solana
npm ci
npm run build:programs
node scripts/opp/patch-idl-errors.js
```

Select the Solana/Anchor versions pinned by that checkout before
building/running. The scenario opts into `enableSolanaFixedPriceOracle`: before
starting any cluster clock, two Report Steps compile a local
Chainlink-compatible oracle fixture and prepare its feed account. The validator
loads both at the configured oracle addresses during genesis. The fixture
returns $100 SOL with eight decimals and a fresh round timestamp from the
validator clock, while the normal outpost executes its address checks, Chainlink
CPI, price validation, and accounting.

The test host needs Rust 1.90 and `cargo-build-sbf` from the pinned Solana
toolchain. Fixture sources and a Cargo lockfile ship with
`@wireio/cluster-tool`; compilation and feed output go under
`<cluster>/data/solana-fixed-price-oracle`, independently for each cluster. No
`development` feature is enabled on the outpost. Ordinary clusters leave the
fixture disabled; external outposts reject it. The generated `start.sh`
preserves the same program and feed preload as live startup.

This flow validates the production oracle consumer with deterministic input. The
actual Chainlink deployment/feed service needs separate integration coverage.
The flow leaves the local outpost in Launching; it does not flip PostLaunch or
submit a depot genesis import.

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

## Verified local run (normal outpost, fixed-price fixture)

On 2026-10-21 the full flow passed in 741 seconds (223 Report Steps) against
wire-solana `f36808e22286ea10a1ff990d0922f89bfc841622`, rebuilt without
`development`; wire-ethereum `97f1fd8c70adea9c0d010714ad3a391cd8774036`;
WIRE runtime reporting `02dfa26a25210aabbe3c6e84a8948ff3e2410812-dirty`;
and a clean, built capital-index `0dd80ec3858fb50a9652e7969b196c0410ec61a2`.
The tested tools tree is the fixture working tree based on `3ed23103`.
The normal `liqsol_core.so` SHA-256 was
`10041d01dce802f95bf0c2c6c7cfbd75ce54cc64ed7cd41d0cec08b798235e76`.

The direct purchase passed the production-oracle CPI assertion. The immediate
export passed the controlled principal, direct-purchase, materialized-yield,
pending-tail, and fully-exited-wallet allocation checks; the later export
matched its wallet allocations and hash. The canonical heartbeat monitor was
armed throughout the run. Local evidence is under
`/tmp/pr149-fixed-oracle-live-20261021-4/reports` and
`/tmp/pr149-fixed-oracle-live-20261021-4/data/solana-genesis-snapshot`.

Full local validation passed `pnpm build`, `pnpm lint`, and `pnpm test:ci`:
460 Jest suites / 4,512 tests plus every package's unit lane, including six Rust
fixture tests and 18 scenario tests. Rust formatting and an actual SBF v3
fixture build also passed.

The earlier hosted run
[39633602628](https://github.com/Wire-Network/wire-platform-build-system/actions/runs/39633602628)
used `3ed23103`, before this fixture: 14 of 15 flows passed, while this scenario
stopped because `WIRE_CAPITAL_INDEX_PATH` was unset. Hosted verification of the
fixture remains pending and requires a built exporter on the runner.

## Earlier local run (development oracle)

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

The later bootstrap-limit assertion uses purchased principal, matching
wire-solana #580 and capital-index #10's review update. The run above predates
that assertion change. Capital-index checks in its raw finalized account capture
and replays it against the same exact balances/hash and the revised bootstrap
limit; that replay and unit checks do not constitute a new live flow run.
