import {
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceParseResultKind,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  parseRunEvidenceIteration,
  parseRunEvidenceSetup,
  parseRunEvidenceTerminal
} from "@wireio/test-opp-stress"

import {
  breakageIteration,
  completedPhase,
  degradedTelemetry,
  EvidenceEndpoint,
  healthyTelemetry,
  saturatedIteration,
  saturatedTerminal,
  withoutKey
} from "./runEvidenceSchemaFixtures.js"

const setupSucceeded = {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Setup,
    status: RunEvidenceSetupStatus.Succeeded,
    startedAtMs: "18446744073709551615",
    endedAtMs: "18446744073709551616",
    clusterConfigCreated: true
  },
  setupFailed = {
    ...setupSucceeded,
    status: RunEvidenceSetupStatus.Failed,
    clusterConfigCreated: false,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "cluster creation failed"
  },
  failedTerminal = {
    ...saturatedTerminal,
    lifecycle: RunEvidenceLifecycle.Failed,
    saturatedEndpoints: [],
    missingEndpoints: [EvidenceEndpoint],
    endpointResults: [
      {
        endpoint: EvidenceEndpoint,
        telemetry: degradedTelemetry,
        saturated: false
      }
    ],
    telemetry: degradedTelemetry,
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.TelemetryIntegrity,
    breakageReason: "persistent checksum mismatch"
  },
  fullySaturatedBreakage = {
    ...saturatedIteration,
    outcome: RunEvidenceIterationOutcome.Breakage,
    breakageCategory: RampBreakageCategory.Workload,
    breakageReason: "workload failed after saturation"
  },
  fullySaturatedFailedTerminal = {
    ...saturatedTerminal,
    lifecycle: RunEvidenceLifecycle.Failed,
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.Workload,
    breakageReason: "workload failed after saturation"
  }

describe("schema-v1 setup and run records", () => {
  it.each([
    ["successful setup", parseRunEvidenceSetup, setupSucceeded],
    ["failed setup", parseRunEvidenceSetup, setupFailed],
    ["saturated iteration", parseRunEvidenceIteration, saturatedIteration],
    ["breakage iteration", parseRunEvidenceIteration, breakageIteration],
    [
      "fully saturated breakage iteration",
      parseRunEvidenceIteration,
      fullySaturatedBreakage
    ],
    ["saturated terminal", parseRunEvidenceTerminal, saturatedTerminal],
    ["failed terminal", parseRunEvidenceTerminal, failedTerminal],
    [
      "fully saturated failed terminal",
      parseRunEvidenceTerminal,
      fullySaturatedFailedTerminal
    ]
  ])("accepts %s", (_label, parser, fixture) => {
    // Given: a complete discriminated schema-v1 record.
    // When: its matching parser receives the record.
    const result = parser(fixture)
    // Then: the value crosses the boundary unchanged.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it.each([
    [
      "not_saturated claiming all endpoints saturated",
      {
        ...saturatedIteration,
        outcome: RunEvidenceIterationOutcome.NotSaturated
      }
    ],
    [
      "completed iteration carrying breakage fields",
      {
        ...saturatedIteration,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "forged"
      }
    ],
    [
      "breakage iteration missing category",
      withoutKey(breakageIteration, "breakageCategory")
    ],
    [
      "breakage iteration missing reason",
      withoutKey(breakageIteration, "breakageReason")
    ],
    [
      "phase missing metrics",
      { ...saturatedIteration, phases: [withoutKey(completedPhase, "metrics")] }
    ],
    [
      "phase missing telemetry",
      {
        ...saturatedIteration,
        phases: [withoutKey(completedPhase, "telemetry")]
      }
    ],
    [
      "phase missing a metric comparison count",
      {
        ...saturatedIteration,
        phases: [
          {
            ...completedPhase,
            metrics: withoutKey(completedPhase.metrics, "envelopeCount")
          }
        ]
      }
    ],
    [
      "phase missing label",
      { ...saturatedIteration, phases: [withoutKey(completedPhase, "label")] }
    ],
    [
      "phase missing strategy",
      {
        ...saturatedIteration,
        phases: [withoutKey(completedPhase, "strategy")]
      }
    ],
    [
      "phase missing baseline",
      {
        ...saturatedIteration,
        phases: [withoutKey(completedPhase, "baseline")]
      }
    ],
    [
      "phase missing window",
      { ...saturatedIteration, phases: [withoutKey(completedPhase, "window")] }
    ],
    [
      "phase missing artifact refs",
      {
        ...saturatedIteration,
        phases: [withoutKey(completedPhase, "artifactRefs")]
      }
    ],
    [
      "failed terminal missing category",
      withoutKey(failedTerminal, "breakageCategory")
    ],
    [
      "failed terminal missing reason",
      withoutKey(failedTerminal, "breakageReason")
    ],
    [
      "saturated terminal with degraded endpoint",
      {
        ...saturatedTerminal,
        endpointResults: [
          {
            endpoint: EvidenceEndpoint,
            telemetry: degradedTelemetry,
            saturated: true
          }
        ]
      }
    ],
    [
      "saturated terminal missing endpoint result",
      { ...saturatedTerminal, endpointResults: [] }
    ],
    [
      "setup masquerading as iteration",
      { ...saturatedIteration, stage: RunEvidenceStage.Setup }
    ],
    [
      "legacy flat setup",
      { kind: "failed_before_saturation", iterationIndex: 0, phase: "setup" }
    ],
    [
      "successful setup with failure data",
      {
        ...setupSucceeded,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "forged"
      }
    ],
    ["failed setup without reason", { ...setupFailed, breakageReason: null }]
  ])("rejects %s", (_label, fixture) => {
    // Given: a contradictory record or downstream-schema omission.
    const stage = Reflect.get(fixture, "stage"),
      parser =
        stage === RunEvidenceStage.Terminal
          ? parseRunEvidenceTerminal
          : stage === RunEvidenceStage.Setup
            ? parseRunEvidenceSetup
            : parseRunEvidenceIteration
    // When: the selected boundary parser runs.
    const result = parser(fixture)
    // Then: the contradictory value is a typed failure.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: RunEvidenceParseResultKind.Failure }
    })
  })
})
