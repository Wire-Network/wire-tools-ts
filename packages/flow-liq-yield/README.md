# flow-liq-yield

The LIQ reward flow end to end, on the REAL `liqsol_core` paths and the real
depot contracts — nothing injected, nothing cranked by hand:

```
liqsol_core::sol_to_liqsol            (SOL outpost — the user deposits SOL, gets liqSOL 1:1)
liqsol_core::set_wire_state           (admin — Launching, then PostLaunch)
liqsol_core::synd                     (user — syndicates liqSOL into the pool)
  → SYNDICATE_LIQ ferried to the depot
  → sysio.msgch → sysio.liq::park       (the key is not linked yet: PARKED)
sysio.authex::createlink              (user — links the same Solana key)
  → sysio.liq::linkswept               (inline: the parked shadow becomes the user's row)
liqsol_core::inject_bonus_synd_yield  (permissionless — SOL-funded pool yield)
liqsol_core::report_liq_yield         (permissionless crank — non-admin signer)
  → LIQ_YIELD ferried to the depot
  → sysio.msgch → sysio.liq::mintyield  (lands in liqpending, outside supply)
batch_operator_plugin → sysio.liq::queueyield   (mints it, funds the swap's reservoir)
batch_operator_plugin → sysio.swap::tickyield   (sells the reservoir through the pool)
  → sysio.liq::addyield                (the WIRE proceeds bump the cumulative index)
sysio.liq::claim                      (user — paid exactly owed(row, index) in WIRE)
sysio.liq::desyndicate                (user — settles, burns, queues DESYNDICATE_LIQ)
  → DESYNDICATE_LIQ ferried to the outpost
  → liqsol_core handle_desyndicate_liq (pays the user's liqSOL ATA inline)
```

Asserts, in order:

1. **The depot parks the syndication.** After `synd`, `SYNDICATE_LIQ` circulates
   and `sysio.liq::parked` holds exactly the syndicated amount against the
   user's (unlinked) Solana key; the user holds no shadow row.
2. **The link delivers it.** After `createlink`, the user's own row holds the
   amount and nothing stays parked — the inline sweep, no permissionless `sweep`.
3. **Reported yield lands outside supply.** `report_liq_yield` advances the
   watermark by at least the donation, `LIQ_YIELD` circulates, and `liqpending`
   holds exactly the reported delta.
4. **The queue crank mints it.** `liqpending` empties and the shadow supply grows
   by exactly the reported yield — the batch operators' `queueyield`.
5. **The tick crank sells it.** The cumulative index moves off zero and the
   reservoir sells out — the batch operators' `tickyield` — so the ledger is
   stable for an exact claim.
6. **The claim is exact.** The user's WIRE balance equals `owed(row, index)`
   computed from the row and the index before the claim, the row is settled at
   the index, and the pot fell by the payout.
7. **The redemption is paid on the outpost.** `DESYNDICATE_LIQ` reaches a
   `DEPOT_OUTPOST_SOLANA` envelope carrying the user's key, the amount and a
   non-zero request id, and the user's liqSOL ATA grows by the burned amount.
8. **The depot keeps advancing** across every attestation.

## What the bootstrap provides

Everything `flow-liq-syndication` relies on (the four wire-solana programs at
genesis, the liqsol surface), plus the depot's shadow-liq system: `sysio.swap`
and `sysio.liq` deployed, the swap configured, one shadow symbol per registered
liq token (`LIQETH`, `LIQSOL`), the kicker — and, because this scenario opts in
through `enableMockLiqPools`, the two mock yield pools `regliqpool` seeds inside
the epoch-0 window (the pool's shadow is minted from nothing, which is why the
seeding is opt-in and a real depot never sets it). The pools' tick pacing (a 30 s
horizon, a 30 % depth cap) is what makes assertion 5 converge in one tick.

The batch operators' `queueyield` and `tickyield` cranks are `nodeop`'s own
(`batch_operator_plugin`, `--batch-yield-tick-interval-ms`); the flow only waits
for their effects.

## Single-shot per cluster

Like `flow-liq-syndication`, the scenario drives the outpost
`PreLaunch -> Launching -> PostLaunch`, which is TERMINAL; the FIRST step of the
Syndicate phase refuses a cluster that is not `PreLaunch`, before any write.
Give every run a fresh `--cluster-path` (what `run-flow.mjs` does by default).

## Running

Like every flow, run it with the canonical runner + heartbeat monitor pair
(see the repo README's "Running flows" / "Monitoring a live flow run" and
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`):

```bash
# From the wire-tools-ts root:
node scripts/run-flow.mjs flow-liq-yield \
  --cluster-path    /tmp/wire-flow-liq-yield \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path   ../wire-ethereum \
  --solana-path     ../wire-solana

# In a second terminal — the mandatory six-probe heartbeat:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-liq-yield
```

The `--wire-build-path` build must carry `sysio.swap` and `sysio.liq` (the
bootstrap deploys both) and a `nodeop` whose `batch_operator_plugin` cranks the
yield path; the `--solana-path` requirements are `flow-liq-syndication`'s.
