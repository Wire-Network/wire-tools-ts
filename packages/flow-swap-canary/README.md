# flow-swap-canary

Configurable FlowScenario for a small, serial proof of the public swap surface.
It uses the canonical cluster bootstrap and PhaseGroup → Phase → Step → Report
engine.

The default `canary` selector runs six representative endpoint directions. In
the fresh flow that is ETH↔SOL, ETH↔WIRE, and SOL↔WIRE. The connected form
discovers ACTIVE public reserve identities from the live depot and prefers a
native asset, falling back deterministically when an endpoint is provisioned
only with a public token such as LIQSOL/PUB. Live rows carry depot-normalized
precision, so the runner validates that value and constructs requests using
the configured token's chain-native precision. A route succeeds when destination
funds land; to-WIRE routes also claim and verify the credited WIRE.
`--wait-for-challenge` is opt-in and additionally waits for each exact UWREQ to
reach `COMPLETED` after the collateral challenge window.

## Run

Use the canonical runner and arm the heartbeat monitor with the same cluster
path:

```bash
node scripts/run-flow.mjs flow-swap-canary \
  --cluster-path /tmp/wire-flow-swap-canary \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana

node scripts/flow-heartbeat-monitor.mjs \
  --cluster-path /tmp/wire-flow-swap-canary

# Union repeatable selectors; wait for challenge completion when requested.
node scripts/run-flow.mjs flow-swap-canary \
  --cluster-path /tmp/wire-flow-swap-canary \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana \
  -- --routes eth-to-sol --routes wire-to-sol --wait-for-challenge
```

## Existing running cluster

The connected command reuses this scenario's PhaseGroups and route Steps while
skipping fresh-cluster bootstrap and collateral deposits:

```bash
packages/cluster-tool/bin/wire-cluster-tool swap-canary \
  --cluster-path /path/to/running/cluster
```

Run it on the cluster host. It loads that cluster's validated persisted config,
state, and keys locally, writes to a timestamped report directory under the
cluster, and accepts the same repeatable `--routes` and
`--wait-for-challenge` options. Never point the normal `run-flow.mjs` command at
a persistent live-cluster directory; that runner owns a fresh cluster lifecycle.

## Route selectors

- `canary` — one representative public reserve per external endpoint; six routes
- `all` — every legal route in the selected fresh or live catalog
- `eth`, `sol`, `wire` — every route touching that endpoint
- `cross-outpost`, `wire-endpoint` — route families
- `eth-to-sol`, `sol-to-eth`, `eth-to-wire`, `wire-to-eth`, `sol-to-wire`,
  `wire-to-sol` — exact endpoint directions

Selectors are unioned, de-duplicated, and executed in canonical serial order.
Same-outpost token swaps are intentionally outside this public route catalog.

## What each route proves

Each selected route uses one shared swap identity and verifies:

1. live quote and pre-request state;
2. ERC-20 approval when required;
3. exactly one source request transaction;
4. explicit ERC-20, SPL, or WIRE source custody movement;
5. exact UWREQ correlation by the emitted source request id;
6. CONFIRMED underwriting and the expected one- or two-leg locks;
7. reserve-book accounting against the live curve and fee configuration;
8. destination delivery, including WIRE claim when applicable;
9. optional challenge completion.

Fresh runs provision selected source assets and underwriter collateral through
existing cluster-tool Steps. Connected runs use the live cluster's collateral.
