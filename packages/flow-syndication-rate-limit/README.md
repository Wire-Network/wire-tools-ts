# flow-syndication-rate-limit

A then B syndicate in one consensus envelope, totaling twice the burst. A's item
exceeds the burst, making arrival order observable. After bonding, the first crank
releases exactly the burst to A; a repeat crank is required to execute in the same
epoch and release zero. The next crank releases exactly min(k × refill, burst),
using the bucket's actual epoch difference. A later crank drains the remainder,
and each observed bucket level stays within capacity.

A redemption above even a full desyndication bucket is refused without a balance,
supply or queue change; a smaller redemption burns and queues the exact amount.
The flow synchronizes writes at epoch boundaries and fails if the required
same-epoch crank pair crosses a boundary; it never weakens finality.

Each run uses a fresh cluster. Scenario defaults opt into mock liquidity pools and
the imported bonder, with 60-second epochs. Pair configuration is set by governance
Steps and restored afterward. The final verify Step requires a clear cord and no
mismatch rows. Every write is a Step, with irreversible WIRE confirmation.

Run the canonical pair (Solana 4.2.0 must be first on PATH):

```sh
node scripts/run-flow.mjs flow-syndication-rate-limit \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run the runner in the background with a log and the monitor alongside it, without
`--expect-freeze`. On BAIL stop the run and preserve its cluster for diagnosis.
The Report under `<cluster>/reports/` is the assertion record. This package has no Jest suite.
