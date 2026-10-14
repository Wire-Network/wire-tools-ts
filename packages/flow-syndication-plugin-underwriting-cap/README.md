# flow-syndication-plugin-underwriting-cap

Proves that the `batch_operator_plugin` underwriter role enforces its exposure cap
and recovers when a bond is paid back, with no flow-side underwriting. Every
bootstrap batch operator runs the role (`enableBatchOperatorUnderwriting`). The
`batchOperatorUnderwriting` option funds only one of them, `batchop.a`, with the
100 LIQSOL epoch-zero import credit, and sets the cap to exactly the first
request's coverage (2.010000000 LIQSOL). That operator is the only possible bonder,
and its first bond exhausts the cap.

Setup sets the pair rules and checks that only the funded operator holds LIQSOL.
The first challenge window is **589 seconds**, sized from the post-bond envelope:
one 60-second scenario epoch for submission, a complete 420-second single hop,
78 seconds of governance finality for three producers, two 15-second active plugin
passes for request issuance and reads, and one 1-second observer poll gap.
Step deadlines remain ceilings that return early; they do not size the window.
`WIRE_FLOW_TIMEOUT_SCALE` scales deadlines only. Once the first request is issued (and has
saved its window), a separate governance Step restores **60-second windows** for
later requests. This limits the necessary extra challenge time to the first
request: **589/60/60-second windows total 709 seconds**, versus the PR head's
720 seconds (three 240-second windows), a reduction of 11 seconds. The governance
Step has a 108-second ceiling: the topology-derived 78-second irreversible-finality
budget plus the shared 30-second Step margin. It adds no fixed sleep.
The flow then acts only as users: two syndications by a linked user, one by an unlinked recipient, and that
recipient's own `createlink`. Typed verify Steps wait for each effect of the
operator:

- The funded operator bonds the first request for its whole coverage, equal to
  the cap.
- The second syndication's request is issued while that bond is unpaid, and is
  held until the bond is paid back. `second-held-by-cap` polls the first bond
  until it reads `paid`, before either custody check. A parallel intake watcher
  starts before the second submission and captures a held reading in the same
  poll iteration that discovers the issued request. The payment watcher retains
  that reading even if the first bond is paid before its own first poll.
  Its nominal poll ceiling is 619 seconds (window plus two 15-second plugin passes),
  with a 649-second enclosing Step. On every reading before payment, taken between two unpaid
  readings of the first bond, the second request must be OPEN with nothing
  bonded and no bond row. It fails if no such reading exists, or if the first
  bond row disappears before it is read paid. The Report row records the
  number of held readings, their wall-clock span, and the first request's
  `resolved_at` at the paid reading, so it shows the hold outlasting the
  approval.
- After the first request is approved (no earlier than its window, by chain time)
  and its bond claimed, the same operator bonds the second request.
  `second-bonded-after-recovery` checks that the first bond is paid. It checks
  that the operator's liquid LIQSOL plus its unpaid stake on the second request
  equals its funded balance from setup (the bounty is 0, so a paid bond returns
  only its stake). A second bond already paid contributes zero stake. If it is
  claimed during the balance read, the Step rereads the liquid balance once
  immediately, with no sleep or new poll. As a secondary check, the second request's `bonded_at` is no
  earlier than the first request's `resolved_at`.
- The operator's unclaimed bonds never exceed the cap, and the unfunded operators
  never bond and end holding nothing.
- Releases carry their exact fees. Custody equals the newest attested
  `total_syndicated` after each syndication. The unlinked recipient's release
  parks exactly its net, and `createlink` delivers it once.
  Custody persistence may finish after cap recovery; the first release check
  accounts for either an unreleased or fully released second envelope.
- The funded operator ends with its credit back, every operator is still ACTIVE,
  the cord is clear and no mismatch row exists.

This is the cap-exhaustion and recovery case heifner's change to
`flow-syndication-underwriting` (wire-tools-ts #120) gave a standalone underwriter
daemon. It supersedes that change for the cap case, with the role on the batch
operators' own nodes. `flow-syndication-plugin-underwriting` keeps the case of all
three operators funded and racing.

Each run uses a fresh cluster with mock liquidity pools, the syndication import
and 60-second epochs. The pair configuration is restored at the end. The run
requires a nodeop built with the `batch_operator_plugin` underwriter role
(wire-sysio PR #671).

Run the canonical pair (Solana 4.2.0 must be first on PATH):

```sh
node scripts/run-flow.mjs flow-syndication-plugin-underwriting-cap \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run the runner in the background with a log and the monitor alongside it, without
`--expect-freeze`. On BAIL stop the run and preserve its cluster for diagnosis.
The Report under `<cluster>/reports/` is the assertion record. The
`second-held-by-cap` row records its held-reading count and span. The
`second-bonded-after-recovery` row records the approval and bond times and the
balance it compared. This package has no Jest suite; `test:unit` checks the verify Steps and that
the flow plans no underwriter write.

All protocol polls run at one-second intervals and return early. Request intake
(first, second and unlinked) has a 720-second poll budget and a 750-second Step
ceiling. Bonding, custody persistence, releases, approvals/claims and parked release
use 420-second polls inside 450-second Steps. Outpost syndication
writes have 60-second ceilings; the `configure-later-requests` governance Step has
a 108-second ceiling, while other depot configuration and key-link writes have
60-second irreversible-finality ceilings. The recovery snapshot adds no wait or
poll: a racing claim causes one immediate balance reread. Explicit timeout scaling
multiplies ceilings and poll budgets, never the 589/60/60-second challenge windows.
