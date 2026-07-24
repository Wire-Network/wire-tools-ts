# @wireio/opp-swap-stress

Flow-specific **swap-stress saturation** logic for the WIRE OPP pipeline — the
jest-tested, pure-logic layer consumed by the `flow-swap-stress-saturation`
scenario executable.

## What lives here

- **Deterministic stress identities** (`stressIdentities.ts`,
  `stressPrivateReserves.ts`) — stable ETH/SOL/WIRE recipient sets derived from
  the public Anvil mnemonic, kept clear of operator/deployer HD slots.
- **Burst + ramp orchestration** (`boundedBursts.ts`, `rampController.ts`,
  `rampCampaignSaturation.ts`, `ethereumBurstDefaults.ts`) — the swap-issuance
  schedule and the campaign that walks it toward envelope saturation.
- **Phase-runner state machine** (`phaseRunner*.ts`, `phaseQuotes.ts`) — the
  two-phase (ETH↔WIRE) saturation runner, its request/telemetry/metric
  projections, and outcome classification.
- **Flow observation + evidence parsing** (`flowObservation*`, `flowPhase*`,
  `flowRunEvidenceAdapter.ts`, `flowTelemetryDegradationParser.ts`,
  `envelopeMetrics.ts`, `realMetricPolling.ts`) — adapters that project the
  generic run-evidence/telemetry surface from `@wireio/test-opp-stress` onto the
  swap-stress flow's observation contract.

## Where it sits

```
@wireio/test-opp-stress      ← generic engine (ramp/evidence/telemetry/metrics)
        ▲
        │  consumed by
@wireio/opp-stress-harness    ← standalone un-privileged testnet harness + CLI
        ▲
        │  consumed by
@wireio/opp-swap-stress       ← THIS package: swap-stress flow logic (pure, jest)
        ▲
        │  consumed by
flow-swap-stress-saturation   ← the FlowScenario executable (live cluster)
```

This package holds **no live-cluster driver**: every symbol is exercised by
synthetic-fixture jest suites under `tests/`. The live orchestration that stands
identities up against a real cluster lives in the `flow-swap-stress-saturation`
scenario's `plan()`.

## Build & test

```bash
pnpm --filter @wireio/opp-swap-stress build   # tsc -b (strictNullChecks on)
pnpm --filter @wireio/opp-swap-stress test    # jest (synthetic fixtures)
```
