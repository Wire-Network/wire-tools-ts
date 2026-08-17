# flow-swap-stress-saturation

Excluded soak: saturate **both** Ethereum OPP directions by ramping low-value
swaps from many wallets through a same-owner PRIVATE reserve pair
(ETH native × USDCSOL SPL).

This flow is on the CI gate's `FLOW_EXCLUDE` deny-list — it is an out-of-band
soak, not a per-PR gate flow.

## Running it

The two canonical scripts, never anything else (see
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`):

```bash
node scripts/run-flow.mjs flow-swap-stress-saturation \
  --cluster-path    /tmp/wire-stress \
  --wire-build-path <wire-sysio>/build/claude \
  --ethereum-path   <wire-ethereum> \
  --solana-path     <wire-solana>

# ...watched, for the run's entire life:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-stress
```

`WIRE_STRESS_LOAD_LEVEL` (`smoke|light|moderate|heavy|saturating`) selects the
preset; unset reproduces this flow's calibrated `saturating` soak. The level
sets the envelope-size target AND the ramp curve together — they are coupled,
since a byte gate is only reachable at a matching account count.

## Layout

The scenario and everything it needs live in this one package.

| Path | What it is |
|---|---|
| `src/SwapStressSaturationScenario.ts` | The `FlowScenario` — `plan()` builds the setup phases and the RunCampaign phase |
| `src/steps/` | Step factories: owner/reserve/user provisioning, the campaign driver |
| `src/stress-engine/` | Ramp controller + saturation decision, envelope/phase metric projection over a pluggable `EnvelopeRecordSource`, telemetry health, bounded workload |
| `src/stress-engine/run-evidence/` | Canonical-JSON run-evidence schema + atomic publication (superseded by the `Report` in a follow-up) |
| `src/swap-stress/` | Bounded bursts, the phase runner, ramp campaign + saturation projection |
| `src/observation-parsing/` | Shared strict parsers for observation records and telemetry health |
| `src/envelope-integrity/` | Strict OPP envelope-artifact reader: descriptor-pinned root, canonical protobuf decode, content-addressed baselines |
| `src/utils/` | `AtomicFile` — crash-safe immutable publish + replaceable checkpoint |
| `tests/` | Jest suites for every symbol above (synthetic fixtures only — no live cluster) |

`strictNullChecks` is ON for this package (see `tsconfig.src.json`): the ramp
evidence union discriminates `OppStressRampBoundaryFailureEvidence` from
`OppStressRampBrokenObservationEvidence` purely on `observation: null`, so the
non-strict compiler cannot tell them apart.

## Testing

`pnpm test` in this package RUNS THE FLOW against a live cluster (that is the
flow contract, and how the CI gate discovers it). The jest suites are reached
as a root jest project — `pnpm test` at the repo root, or
`npx jest --selectProjects flow-swap-stress-saturation`.
