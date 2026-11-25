# flow-syndication-rate-limit

A then B syndicate in one consensus envelope, totaling two bursts and one second of
refill. A's item exceeds the burst, making arrival order observable. After bonding,
the first crank releases exactly the burst to A. The next crank releases exactly
min(refill × elapsed seconds, burst), using the bucket's actual `last_refill`
difference; since it can release at most one burst, it always leaves work behind.
A crank a full refill later must release a positive tranche at a later bucket tick
and drain the remainder, and each observed bucket level stays within capacity.

A redemption above even a full desyndication bucket is refused without a balance,
supply or queue change; a smaller redemption burns and queues the exact amount.
The flow then waits for the external destination wallet to receive that exact
amount. A queued instruction alone cannot pass the flow.
The flow aligns both arrivals to one outpost envelope and never weakens finality: it
waits until Solana's current epoch is decided and the chain idle (no traffic), adding
no traffic itself. The outpost has then answered the depot's current envelope and
emits its next only on the depot's next one, which needs traffic and then a whole
minimum from it, so both writes land before it; the relays' report of the outpost's
backlog to the depot (`sysio.msgch::reportqueue`), made only after the first write, gives
Solana that traffic, and the intake waits add none. A wait for a new epoch would not
do: the outpost answers a depot envelope only after the advance that ships it, so the
two writes could straddle that answer. Epochs are depot-paced: Solana's come from the
intakes' backlog report and from the redemption, the flow's only depot → Solana traffic.

Each run uses a fresh cluster. Scenario defaults opt into mock liquidity pools and
the imported bonder, with a 60-second minimum epoch. Pair configuration is set by governance
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
The Report under `<cluster>/reports/` is the assertion record. Focused wallet-settlement regressions run with `pnpm run test:unit`; the live flow remains the end-to-end gate.
