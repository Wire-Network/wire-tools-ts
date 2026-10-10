# flow-syndication-underwriting

The linked user syndicates a non-increment-multiple amount, which stays in the
syndication holder row until bonded. A second envelope waits without a request.
The flow then starts the bonder's underwriter daemon (the batch operator plugin's
underwriter role, on its own node) and pushes no bond, crank, approval or claim
itself: the daemon checks each request against the Solana outpost's record of the
envelope, bonds it, cranks `sysio.synd`, and approves and claims after the
challenge window. Its first bond releases the first net amount with its exact fee
and issues the second request. Its exposure cap is the first request's covered
amount, so it bonds the second request only once the first bond is paid back. A
later unlinked recipient receives parked shadow through `createlink`. Typed verify
Steps check every balance, state and custody assertion.

Release follows BONDED as specified by `sysio.synd`; the challenge window gates
approval and return of the bond. It does not gate the initial release.

Each run uses a fresh cluster. Scenario defaults opt into mock liquidity pools and
the imported bonder, with 60-second epochs. Pair configuration is set by governance
Steps and restored afterward. The final verify Step requires a clear cord and no
mismatch rows. Every write the flow makes is a Step, with irreversible WIRE
confirmation; the daemon's writes are awaited by Steps that push nothing.

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
