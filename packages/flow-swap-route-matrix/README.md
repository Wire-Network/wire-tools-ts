# Configured Swap Route Matrix

`flow-swap-route-matrix` is the exhaustive, serial conformance flow for every
meaningful ordered pair among the seven currently supported public outpost
tokens plus WIRE. It reuses the cluster harness's identity, reserve-quote,
swap, funding, and underwriter tools.

```text
CrossOutpostRoutes
  EthereumToSolana  3 Ethereum tokens × 4 Solana tokens = 12 routes
  SolanaToEthereum  4 Solana tokens × 3 Ethereum tokens = 12 routes
SameOutpostRoutes
  EthereumToEthereum  3 × 2 distinct-token directions = 6 routes
  SolanaToSolana      4 × 3 distinct-token directions = 12 routes
ExternalToWireRoutes
  EthereumToWire    3 routes
  SolanaToWire      4 routes
WireToExternalRoutes
  WireToEthereum    3 routes
  WireToSolana      4 routes

Total: 56 exact directed supported routes
```

The catalog contains only advertised supported routes. LIQETH remains outside
this conformance flow while its source-custody policy is unresolved.

Every exact token direction is its own Phase with explicit authorization,
request, custody, UWREQ, confirmation, lock, and payout Steps. The package
exports one `planSwapRouteMatrix` composition boundary; family, direction, and
route assembly remain implementation details.

Routes run serially because they share one Ethereum, Solana, and WIRE identity;
parallel execution would create nonce and balance-baseline races. Standard
cluster-tool fail-fast behavior stops at the first failed route. This is
long-running conformance coverage, not a stress test. Private-reserve behavior
remains in `flow-swap-private-reserves`.

The local stablecoin routes use the outpost mock-token addresses.

Run it through the canonical flow runner and attach the heartbeat monitor for
the generated cluster path:

```bash
./scripts/run-flow.mjs flow-swap-route-matrix \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana
```

Pair every live run with the canonical heartbeat monitor for its generated
cluster path, as required by the repository flow-running rules.
