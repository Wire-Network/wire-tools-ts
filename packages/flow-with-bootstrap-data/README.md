# flow-with-bootstrap-data

Acceptance flow for the OPS-197 prelaunch distribution-claim importer. It boots
a real cluster with the committed Ethereum and Solana indexer-shaped fixtures in
`fixtures/`, then verifies:

- deterministic address normalization, deduplication, yield-claimed netting,
  Ethereum decimal flooring, and per-chain totals;
- `sysio.dclaim::importdone` closed the import window; and
- every exact chain/address/WIRE balance landed in `unmapped_tokens`.

Run it with the canonical runner and keep the heartbeat monitor running for
the lifetime of the flow:

```bash
./scripts/run-flow.mjs flow-with-bootstrap-data \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path ../wire-ethereum \
  --solana-path ../wire-solana \
  --cluster-path /tmp/wire-flow-with-bootstrap-data

# In a second terminal — required while the flow is running:
node scripts/flow-heartbeat-monitor.mjs \
  --cluster-path /tmp/wire-flow-with-bootstrap-data
```
