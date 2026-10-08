# flow-syndication-underwriting

The linked user syndicates a non-increment-multiple amount, which stays in the
syndication holder row until bonded. A second envelope waits without a request.
Bonding and cranking releases the first net amount with its exact fee, then issues
the second request. Approval waits for the challenge window and the claim returns
the bonder's stake. A later unlinked recipient receives parked shadow through
`createlink`. Typed verify Steps check every balance, state and custody assertion.

Release follows BONDED as specified by `sysio.synd`; the challenge window gates
approval and return of the bond. It does not gate the initial release.

Each run uses a fresh cluster. Scenario defaults opt into mock liquidity pools and
the imported bonder, with 60-second epochs. Pair configuration is set by governance
Steps and restored afterward. The final verify Step requires a clear cord and no
mismatch rows. Every write is a Step, with irreversible WIRE confirmation.

Run the canonical pair (Solana 4.2.0 must be first on PATH):

```sh
node scripts/run-flow.mjs flow-syndication-underwriting \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run the runner in the background with a log and the monitor alongside it, without
`--expect-freeze`. On BAIL stop the run and preserve its cluster for diagnosis.
The Report under `<cluster>/reports/` is the assertion record. This package has no Jest suite.
