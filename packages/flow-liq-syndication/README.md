# flow-liq-syndication

Validates that the `simple_swap` liq-syndication attestations reach the depot
through the REAL `liqsol_core` paths — nothing is injected:

```
liqsol_core::sol_to_liqsol          (SOL outpost — user deposits SOL, gets liqSOL 1:1)
liqsol_core::set_wire_state         (admin — Launching, then PostLaunch)
liqsol_core::synd                   (user — syndicates liqSOL into the pool)
  → SYNDICATE_LIQ queued by the program
liqsol_core::inject_bonus_synd_yield (permissionless — SOL-funded pool yield)
liqsol_core::report_liq_yield        (permissionless crank — non-admin signer)
  → LIQ_YIELD queued by the program
  → batch operator ferries both via an OPP envelope
  → sysio.msgch consumes the envelope
      (its dispatcher does NOT handle these types yet — they fall
       through the unknown-type default, by design)
  → sysio.epoch::advance keeps closing epochs
```

Asserts:

1. **SYNDICATE_LIQ circulates.** After the user's `synd`, a `SYNDICATE_LIQ`
   type tag appears inside an `OUTPOST_SOLANA_DEPOT` envelope artifact under
   `<cluster>/data/opp-debugging/`.
2. **LIQ_YIELD circulates, and carries the reported delta.** The crank advances
   `GlobalState`'s liq-yield watermark by at least the donated lamports and
   consumes exactly one value of the shared liq sequence; the circulated
   attestation is DECODED and must match that delta, that sequence, the
   outpost's chain code and the depot's liqSOL token code.
3. **The depot accepts envelopes carrying unknown types.**
   `sysio.epoch::epochstate.current_epoch_index` advances past the value
   snapshotted before the syndication — a depot that choked on an unhandled
   attestation type would stall the epoch instead.

## What the harness provides

The bootstrap loads all four wire-solana programs (`liqsol_core`,
`liqsol_token`, `transfer_hook`, `validator_leaderboard`) onto the cluster's
validator at genesis with the per-cluster deployer as their upgrade authority,
then stands up the liqsol surface by running wire-solana's own `init-*` scripts
— one Report step each — before the OPP outpost bootstrap. That is what creates
the liqSOL mint, its transfer hook, the distribution / stake / withdraw state,
the leaderboard, the wire `GlobalState` and the reserve pool.

The one thing the bootstrap deliberately leaves to this flow is the liq-token
mapping: `synd` and `report_liq_yield` denominate their attestation in a depot
token code resolved through `OutpostConfig::token_code_for_mint`, and the
bootstrap binds that code to the mock SPL mint the swap flows use. The
scenario's first step re-binds it to the REAL liqSOL mint, so only this flow's
cluster sees the change.

`DESYNDICATE_LIQ` is depot-originated and has no depot emitter yet, so this flow
does not exercise it.

## Single-shot per cluster

The scenario drives the outpost `PreLaunch -> Launching -> PostLaunch`, and
`PostLaunch` is TERMINAL in `liqsol_core`'s state machine. So the flow runs
once per cluster: a second run against the same `--cluster-path` fails at
`outpost-is-pre-launch`, the FIRST step of the Syndicate phase, which names the
state it found — rather than at an `InvalidWireState` revert that would read as
a program fault. The check leads the phase deliberately: every step after it
writes, so a refused run spends nothing. Give every run a fresh
`--cluster-path` (what `run-flow.mjs` does by default).

## Running

Like every flow, run it with the canonical runner + heartbeat monitor pair
(see the repo README's "Running flows" / "Monitoring a live flow run" and
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`):

```bash
# From the wire-tools-ts root:
node scripts/run-flow.mjs flow-liq-syndication \
  --cluster-path    /tmp/wire-flow-liq-syndication \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path   ../wire-ethereum \
  --solana-path     ../wire-solana

# In a second terminal — the mandatory six-probe heartbeat:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-liq-syndication
```

Cluster data lands under `--cluster-path` (env `WIRE_CLUSTER_PATH`); omit it
and the harness generates a fresh temp dir per run.

The `--solana-path` tree must carry a current build of the wire-solana programs
— the one the harness deploys, `npm install && npm run build:programs` (a bare
`anchor build` is not equivalent) — so that all four `target/deploy/*.so` and
`target/idl/*.json` are present and their IDL-declared program ids match the
committed `.keys/*-keypair.json` ids. The bootstrap's `verify-program-ids` step
fails fast with the remediation when those ids drift. `node_modules` must be
installed there too: the bootstrap drives the repo's `init-*` scripts with
`anchor run`.
