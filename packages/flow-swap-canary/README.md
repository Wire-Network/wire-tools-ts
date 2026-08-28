# flow-swap-canary

Configurable FlowScenario for a small, serial proof of the public swap surface.
It uses the canonical cluster bootstrap and PhaseGroup → Phase → Step → Report
engine. It does not depend on the Hub, SDK outpost, Noco, deployment profiles,
or S3 artifacts.

The default `canary` selector runs the six native endpoint directions:
ETH↔SOL, ETH↔WIRE, and SOL↔WIRE. A route succeeds when destination funds land;
to-WIRE routes also claim the credited WIRE and verify its liquid balance.
`--wait-for-challenge` is opt-in and additionally waits for each exact UWREQ to
reach `COMPLETED` after the collateral challenge window.

## Run

Use the repository runner so path validation and heartbeat monitoring remain
identical to every other live flow:

```bash
./scripts/run-flow.mjs flow-swap-canary \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana

# Union repeatable selectors; wait for challenge completion when requested.
./scripts/run-flow.mjs flow-swap-canary \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana \
  -- --routes eth-to-sol --routes wire-to-sol --wait-for-challenge
```

## Route selectors

- `canary` — six native endpoint routes; the default
- `all` — all 48 legal public token routes
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

Selected non-native user funds and underwriter collateral are provisioned by
existing cluster-tool Step factories. Route phases remain serial because they
share one user and persistent collateral locks.
