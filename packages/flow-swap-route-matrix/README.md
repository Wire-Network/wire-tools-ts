# Native Swap Route Matrix

`flow-swap-route-matrix` is the serial native-route conformance flow for the
three user-facing endpoints. It reuses the cluster harness's existing swap,
identity, reserve-quote, and underwriter tools.

```text
CrossOutpostRoutes
  EthereumToSolana  ETH → SOL
  SolanaToEthereum  SOL → ETH
ExternalToWireRoutes
  EthereumToWire    ETH → WIRE
  SolanaToWire      SOL → WIRE
WireToExternalRoutes
  WireToEthereum    WIRE → ETH
  WireToSolana      WIRE → SOL
```

Every route Phase reports the same lifecycle: live quote and baselines, one
source request write, route-specific UWREQ creation, confirmation, expected
lock count, and destination payout. Route phases and groups run serially by
default; this is conformance coverage, not a stress test.

Non-native ERC-20 and SPL routes remain in
`flow-swap-non-native-tokens`. Private-reserve behavior remains in
`flow-swap-private-reserves`.

Run it through the canonical flow runner and attach the heartbeat monitor for
the generated cluster path:

```bash
./scripts/run-flow.mjs flow-swap-route-matrix \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana
```
