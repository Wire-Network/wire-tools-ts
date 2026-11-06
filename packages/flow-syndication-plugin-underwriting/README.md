# flow-syndication-plugin-underwriting

Proves that the `batch_operator_plugin` underwriter role, configured properly, is
enough to underwrite syndication with no other intervention. All configuration
happens before the first syndication:

- `enableBatchOperatorUnderwriting` runs the role on every bootstrap batch
  operator, which bonds from its own account with its relay key.
- The epoch-zero mock syndication import credits each operator's own ED key with
  100 LIQSOL, which lands liquid in its linked account.
- Governance sets the pair rules.

From then on the flow acts only as users: two syndications by a linked user, one
by an unlinked recipient, and that recipient's own `createlink`. It pushes no
bond, crank, approval, claim, funding or prune. No flow account provides bonds:
`synd.bonder` is not provisioned.

Typed verify Steps wait for each effect of the operators and check it exactly:

- Every request is bonded for its whole coverage by batch operators, checked
  right after the request is issued, while the challenge window keeps the bond
  rows unpaid. Each operator's unclaimed bonds across the flow's requests stay
  within its 10 LIQSOL exposure cap.
- Coverage rounds up to the bond increment. After each syndication the pool
  equals the newest attested `total_syndicated`, read across `SYNDICATE_LIQ` and
  `LIQ_YIELD` by outpost sequence once no claimed yield is unreported and that
  sequence is persisted. The attested total grows by exactly the second
  syndication plus any yield claimed in between.
- Each envelope is released with its exact fee, crediting the user.
- The second request is issued no earlier than the first was bonded.
- Each request is approved no earlier than its challenge window allows, by chain
  time, and every bond is claimed.
- The unlinked recipient's release parks exactly its net, and `createlink`
  delivers it once.
- The operators' LIQSOL together returns to exactly its funded total, and the
  `sysio.synd` holder keeps only the fees it collected. Every operator is still
  ACTIVE, the cord is clear and no mismatch row exists.

Each wait polls for a state the operators cannot take back, so poll timing never
decides the verdict. The intermediate states `flow-syndication-underwriting`
asserts before any bond are not asserted here: a REQUESTED envelope holding S,
a later envelope WAITING with no request, and an unlinked envelope held before
its bond. A running underwriter may already have moved each one on.

Each run uses a fresh cluster with mock liquidity pools, the syndication import
and 60-second epochs. The pair configuration is restored at the end. The run
requires a nodeop built with the `batch_operator_plugin` underwriter role
(wire-sysio PR #671: `--batch-underwriter-account`,
`--batch-underwriter-max-exposure`).

Run the canonical pair (Solana 4.2.0 must be first on PATH):

```sh
node scripts/run-flow.mjs flow-syndication-plugin-underwriting \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run the runner in the background with a log and the monitor alongside it, without
`--expect-freeze`. On BAIL stop the run and preserve its cluster for diagnosis.
The Report under `<cluster>/reports/` is the assertion record. This package has
no Jest suite; `test:unit` checks the verify Steps and that the flow plans no
underwriter write.
