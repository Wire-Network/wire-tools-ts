# flow-liq-syndication

Validates that the three `simple_swap` liq-syndication attestation types
circulate through OPP without disturbing the depot:

```
liqsol_core::add_attestation        (SOL outpost — the enqueue surface
  → SYNDICATE_LIQ attestation        `synd` / `report_liq_yield` use)
  → LIQ_YIELD attestation
  → batch operator ferries via an OPP envelope
  → sysio.msgch consumes the envelope
      (its dispatcher does NOT handle these types yet — they fall
       through the unknown-type default, by design)
  → sysio.epoch::advance keeps closing epochs
```

Asserts:

1. **SYNDICATE_LIQ circulates.** After the injection, a `SYNDICATE_LIQ`
   type tag appears inside an `OUTPOST_SOLANA_DEPOT` envelope artifact
   under `<cluster>/data/opp-debugging/`.
2. **LIQ_YIELD circulates.** The same, for the next value on the
   outpost's shared liq sequence.
3. **The depot accepts envelopes carrying unknown types.**
   `sysio.epoch::epochstate.current_epoch_index` advances past the value
   snapshotted before the injections — a depot that choked on an
   unhandled attestation type would stall the epoch instead.

## Why the attestations are injected, not produced

The harness deploys only `liqsol_core` — no `liqsol-token`, no
Token-2022 transfer hook, no distribution state — so a real
`synd` / `report_liq_yield` cannot execute against a flow cluster.
`liqsol_core::add_attestation` is the exact enqueue surface those
instructions use once the liqsol surface is present, so a synthetic
enqueue exercises the identical downstream path. Same rationale as
`flow-yield-distribution`'s Solana side.

`DESYNDICATE_LIQ` is depot-originated and has no depot emitter yet (and
the Solana relay carries no effect shape for it), so this flow does not
exercise it; only its encoder + envelope scanner ship with the harness.

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
