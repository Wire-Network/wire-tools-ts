import {
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceParseResultKind,
  RunEvidenceRecordKind,
  parseRunEvidenceIteration,
  parseRunEvidenceTerminal
} from "@wireio/test-opp-stress"

import {
  completedPhase,
  emptyTelemetry,
  EvidenceEndpoint,
  healthyTelemetry,
  saturatedIteration,
  saturatedTerminal
} from "./runEvidenceSchemaFixtures.js"

const notSaturatedPhase = {
    ...completedPhase,
    metrics: { ...completedPhase.metrics, saturated: false }
  },
  notSaturatedIteration = {
    ...saturatedIteration,
    outcome: RunEvidenceIterationOutcome.NotSaturated,
    saturatedEndpoints: [],
    missingEndpoints: [EvidenceEndpoint],
    endpointResults: [
      {
        endpoint: EvidenceEndpoint,
        telemetry: healthyTelemetry,
        saturated: false
      }
    ],
    phases: [notSaturatedPhase]
  },
  incompleteTerminal = {
    ...saturatedTerminal,
    lifecycle: RunEvidenceLifecycle.Incomplete,
    saturatedEndpoints: [],
    missingEndpoints: [EvidenceEndpoint],
    endpointResults: [
      {
        endpoint: EvidenceEndpoint,
        telemetry: healthyTelemetry,
        saturated: false
      }
    ],
    preserveCluster: true
  },
  setupFailedTerminal = {
    ...saturatedTerminal,
    lifecycle: RunEvidenceLifecycle.SetupFailed,
    saturatedEndpoints: [],
    missingEndpoints: [EvidenceEndpoint],
    endpointResults: [
      {
        endpoint: EvidenceEndpoint,
        telemetry: emptyTelemetry,
        saturated: false
      }
    ],
    telemetry: emptyTelemetry,
    iterationRefs: [],
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "cluster creation failed"
  }

describe("schema-v1 non-saturated terminal variants", () => {
  it.each([
    [
      "not-saturated iteration",
      parseRunEvidenceIteration,
      notSaturatedIteration
    ],
    [
      "incomplete exact-max terminal",
      parseRunEvidenceTerminal,
      incompleteTerminal
    ],
    ["setup-failed terminal", parseRunEvidenceTerminal, setupFailedTerminal]
  ])("accepts %s", (_label, parser, fixture) => {
    // Given: a complete non-saturated lifecycle variant.
    // When: the matching parser receives it.
    const result = parser(fixture)
    // Then: exact-max and pre-setup preservation states remain representable.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it("rejects an unclaimed saturated phase in a not-saturated iteration", () => {
    // Given: endpoint sets say missing while the recorded phase target says saturated.
    const contradictory = {
      ...notSaturatedIteration,
      phases: [completedPhase]
    }
    // When: the iteration crosses the parser boundary.
    const result = parseRunEvidenceIteration(contradictory)
    // Then: recorded phase and endpoint decisions cannot disagree.
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: RunEvidenceParseResultKind.Failure,
        record: RunEvidenceRecordKind.Iteration
      }
    })
  })

  it("rejects setup failure after any endpoint saturation", () => {
    // Given: a setup-failed terminal claims endpoint saturation without iterations.
    const contradictory = {
      ...setupFailedTerminal,
      saturatedEndpoints: [EvidenceEndpoint],
      missingEndpoints: [],
      endpointResults: [
        {
          endpoint: EvidenceEndpoint,
          telemetry: emptyTelemetry,
          saturated: true
        }
      ]
    }
    // When: the setup-failed terminal crosses the parser boundary.
    const result = parseRunEvidenceTerminal(contradictory)
    // Then: setup failure remains constrained to zero saturation.
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: RunEvidenceParseResultKind.Failure,
        record: RunEvidenceRecordKind.Terminal
      }
    })
  })
})
