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

LIQETH is excluded from both sides of the positive matrix because its rebasing
transfer semantics currently trigger ReserveManager's fee-on-transfer guard.
One isolated policy check funds and approves a real LIQETH balance, then uses a
non-mutating `requestSwapErc20WithApproval.staticCall` that must reject with
`WIRE_FeeOnTransferUnsupported`. The check fails if LIQETH starts succeeding or
if the rejection changes, making a future protocol decision visible without
poisoning the supported routes.

Every exact token direction is its own Phase with explicit authorization,
request, custody, UWREQ, confirmation, lock, and payout Steps. The exported
planner hierarchy is `planSwapRouteMatrix` → `planSwapRouteFamily` →
`planSwapRouteDirection` → `planSwapRoute`, so another `FlowScenario` can
compose the whole matrix or any narrower layer without copying its runners.

Routes run serially because they share one Ethereum, Solana, and WIRE identity;
parallel execution would create nonce and balance-baseline races. The flow
collects every route result by default: failures remain failures in the final
Report but do not omit later routes. Set `WIRE_FLOW_FAILURE_MODE=fail-fast` to
stop at the first failed route. This is long-running conformance coverage, not
a stress test. Private-reserve behavior remains in
`flow-swap-private-reserves`.

The local stablecoin routes use the outpost mock-token addresses. The LIQETH
policy check uses the real token address from `liqeth-addrs.json` and acquires a
balance through the deployed `DepositManager`. Ethereum swap submissions reset
the shared nonce cache when a pre-broadcast call rejects, so one unsupported
source cannot strand later requests above a missing nonce.

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
