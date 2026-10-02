# flow-syndication-challenge

A preliminary syndication pays a real fee to fund a nonzero bounty. The challenged
syndication releases one tranche and keeps the remainder held (refill is zero).
An independently funded, newly created account posts the hold bond plus extra.
Governance rules INVALID and the crank burns both the held remainder and the
released amount out of the forfeited bond. Supply returns to its pre-intake value;
the holder retains the net payment and the unused forfeit enters the fee pot.
The challenger claims its hold bond and bounty. The bonder receives no shadow;
its claim can either refuse as empty or settle forfeited WIRE yield to the protocol.
A subsequent admitted syndication proves excess custody and no mismatch. Held
yield can add custody beyond the burned amount. Debug logging is enabled through
scenario defaults so the verify Step can read the contract’s `EXCESS` observation.
That successful probe is then explicitly validated by `sysio`, normal bucket rules
are restored, and its full principal must reach the holder. The intentionally
INVALID deposit retains its burn/forfeit checks; it is never relabeled successful.

Each run uses a fresh cluster. Scenario defaults opt into mock liquidity pools and
the imported bonder, with 60-second epochs. Pair configuration is set by governance
Steps and restored afterward. The final verify Step requires a clear cord and no
mismatch rows. Every write is a Step, with irreversible WIRE confirmation.

Run the canonical pair (Solana 4.2.0 must be first on PATH):

```sh
node scripts/run-flow.mjs flow-syndication-challenge \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run the runner in the background with a log and the monitor alongside it, without
`--expect-freeze`. On BAIL stop the run and preserve its cluster for diagnosis.
The Report under `<cluster>/reports/` is the assertion record. Focused wallet-settlement regressions run with `pnpm run test:unit`; the live flow remains the end-to-end gate.
