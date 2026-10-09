# flow-liq-yield

Exercises the liqSOL reward and redemption path through `sysio.synd` underwriting.
Every write is a Report Step; depot confirmations wait for irreversibility.

1. Provision the user and bonder accounts with separate create and resource-policy
   Steps. Link the imported bonder's Solana key through `createlink`; the inline
   `sysio.synd::linkswept` delivers its parked shadow as liquid bonding capacity.
2. Deposit SOL for liqSOL, transition the outpost to PostLaunch and call `synd`
   through the strict account map, including `globalConfig`.
3. Verify `SYNDICATE_LIQ` circulates and its closed depot envelope holds the full
   item. Before bonding, neither parked nor user shadow is credited.
4. Bond that envelope using `WireSyndicationTool.planBondEnvelope` with its
   runtime epoch output. Crank `sysio.synd`, verify the unlinked credit is parked,
   then link the user's key and verify delivery. Wait out the challenge window,
   approve and claim the bond through `planApproveAndClaim`.
5. Donate bonus pool yield and call permissionless `report_liq_yield`. Verify the
   reported delta circulates and stays held outside `liqpending` and supply.
   Bond and crank its envelope, then approve and claim after its window.
6. Verify the operators' `queueyield` and `tickyield` cranks mint and sell the
   reported yield. Claim exactly the WIRE owed by the cumulative index and
   verify the pot falls by the payout.
7. Call `sysio.synd::desyndicate`. Verify the outbound attestation and the user's
   liqSOL payout equal the burned amount minus the floor-rounded
   `desynd_fee_bps` read from `syndconfig`.
8. Verify epochs advanced, the emergency cord is clear and `mismatch` is empty.

## Bootstrap defaults

The scenario opts into `enableMockLiqPools` and `enableMockSyndicationImport` in
`defaults`. These epoch-zero seeds are backed by custody on both outposts;
Ethereum principal is reconciled by the bootstrap. No seed runs from `plan()`
and no per-flow environment override is required. The bond, syndication and
emergency-stop contracts are deployed and configured by the normal bootstrap.

The operators drive `queueyield` and `tickyield`; the flow explicitly drives
bond acceptance, release cranks, approval and claims as separate Steps.

## Single-shot per cluster

The scenario transitions `PreLaunch -> Launching -> PostLaunch`. Use a fresh
cluster directory for every run; the first Syndicate Step checks PreLaunch.

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

The `--wire-build-path` build must carry `sysio.swap`, `sysio.liq`, `sysio.synd`,
`sysio.bond` and `sysio.andon` and a `nodeop` whose `batch_operator_plugin` cranks the
yield path; the `--solana-path` requirements are `flow-liq-syndication`'s.
