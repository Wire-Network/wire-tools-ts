import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceClusterConfigState,
  RunEvidenceConfigUnavailableReason,
  RunEvidenceLifecycle,
  RunEvidenceParseResultKind,
  RunEvidenceRecordKind,
  RunEvidenceSchemaVersion,
  parseRunEvidenceManifest
} from "@wireio/test-opp-stress"

import {
  artifactEntry,
  capturedSnapshot,
  committedRecordRefs,
  degradedTelemetry,
  EvidenceEndpoint,
  healthyTelemetry,
  initializingManifest,
  iterationRecordRef,
  setupRecordRef,
  terminalRecordRef,
  withoutKey
} from "./runEvidenceSchemaFixtures.js"

const runningManifest = {
    ...initializingManifest,
    lifecycle: RunEvidenceLifecycle.Running,
    clusterConfigSnapshot: capturedSnapshot,
    telemetry: healthyTelemetry,
    records: { ...committedRecordRefs, terminal: null },
    artifacts: [artifactEntry]
  },
  setupFailedRecords = {
    setup: setupRecordRef,
    iterations: [],
    terminal: terminalRecordRef
  }

describe("schema-v1 run evidence manifest", () => {
  it.each([
    ["initializing", initializingManifest],
    ["running", runningManifest],
    [
      "setup failed before config",
      {
        ...initializingManifest,
        lifecycle: RunEvidenceLifecycle.SetupFailed,
        clusterConfigSnapshot: {
          kind: RunEvidenceClusterConfigState.Unavailable,
          reason: RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
        },
        records: setupFailedRecords
      }
    ],
    [
      "setup failed after config",
      {
        ...initializingManifest,
        lifecycle: RunEvidenceLifecycle.SetupFailed,
        clusterConfigSnapshot: capturedSnapshot,
        records: setupFailedRecords
      }
    ],
    [
      "failed",
      {
        ...runningManifest,
        lifecycle: RunEvidenceLifecycle.Failed,
        telemetry: degradedTelemetry,
        records: committedRecordRefs
      }
    ],
    [
      "failed after complete saturation",
      {
        ...runningManifest,
        lifecycle: RunEvidenceLifecycle.Failed,
        saturatedEndpoints: [EvidenceEndpoint],
        missingEndpoints: [],
        records: committedRecordRefs
      }
    ],
    [
      "incomplete",
      {
        ...runningManifest,
        lifecycle: RunEvidenceLifecycle.Incomplete,
        records: committedRecordRefs
      }
    ],
    [
      "saturated",
      {
        ...runningManifest,
        lifecycle: RunEvidenceLifecycle.Saturated,
        saturatedEndpoints: [EvidenceEndpoint],
        missingEndpoints: [],
        preserveCluster: false,
        records: committedRecordRefs
      }
    ]
  ])("accepts %s lifecycle evidence", (_label, fixture) => {
    // Given: a complete lifecycle-discriminated manifest fixture.
    // When: the unknown value is parsed.
    const result = parseRunEvidenceManifest(fixture)
    // Then: the parser preserves the clean v1 value.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it.each([
    [
      "initializing with an artifact",
      { ...initializingManifest, artifacts: [artifactEntry] }
    ],
    [
      "setup_failed with an iteration",
      {
        ...initializingManifest,
        lifecycle: RunEvidenceLifecycle.SetupFailed,
        clusterConfigSnapshot: capturedSnapshot,
        records: {
          ...setupFailedRecords,
          iterations: [iterationRecordRef]
        }
      }
    ],
    [
      "setup_failed with endpoint saturation",
      {
        ...initializingManifest,
        lifecycle: RunEvidenceLifecycle.SetupFailed,
        saturatedEndpoints: [EvidenceEndpoint],
        missingEndpoints: [],
        clusterConfigSnapshot: capturedSnapshot,
        records: setupFailedRecords
      }
    ],
    [
      "pending after initialization",
      { ...initializingManifest, lifecycle: RunEvidenceLifecycle.Running }
    ],
    [
      "unavailable after setup success",
      {
        ...runningManifest,
        clusterConfigSnapshot: {
          kind: RunEvidenceClusterConfigState.Unavailable,
          reason: RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
        }
      }
    ],
    [
      "captured config without path",
      {
        ...runningManifest,
        clusterConfigSnapshot: {
          kind: RunEvidenceClusterConfigState.Captured,
          sha256: "a".repeat(64)
        }
      }
    ],
    [
      "captured config without full hash",
      {
        ...runningManifest,
        clusterConfigSnapshot: { ...capturedSnapshot, sha256: "abc" }
      }
    ],
    [
      "unknown schema",
      { ...initializingManifest, schemaVersion: RunEvidenceSchemaVersion + 1 }
    ],
    ["missing telemetry", withoutKey(initializingManifest, "telemetry")],
    [
      "missing saturated endpoints",
      withoutKey(initializingManifest, "saturatedEndpoints")
    ],
    [
      "missing missing endpoints",
      withoutKey(initializingManifest, "missingEndpoints")
    ],
    [
      "missing preservation decision",
      withoutKey(initializingManifest, "preserveCluster")
    ],
    [
      "unsafe numeric timestamp",
      { ...initializingManifest, startedAtMs: 18_446_744_073_709_552_000 }
    ],
    [
      "relative provenance",
      {
        ...initializingManifest,
        provenance: {
          ...initializingManifest.provenance,
          ethereumPath: "../ethereum"
        }
      }
    ],
    [
      "duplicate endpoint",
      {
        ...initializingManifest,
        requiredEndpoints: [EvidenceEndpoint, EvidenceEndpoint]
      }
    ],
    [
      "contradictory endpoint sets",
      {
        ...initializingManifest,
        saturatedEndpoints: [EvidenceEndpoint],
        missingEndpoints: []
      }
    ],
    [
      "legacy path-only record refs",
      {
        ...runningManifest,
        records: {
          setup: "setup.json",
          iterations: ["iterations/000000.json"],
          terminal: null
        }
      }
    ],
    ["manifest self hash", { ...initializingManifest, sha256: "d".repeat(64) }],
    [
      "non-empty initializing telemetry",
      {
        ...initializingManifest,
        telemetry: {
          ...initializingManifest.telemetry,
          kind: OppEnvelopeTelemetryHealthKind.Healthy
        }
      }
    ]
  ])("rejects %s", (_label, fixture) => {
    // Given: a verifier mutation or an exact-schema omission.
    // When: the malformed manifest is parsed.
    const result = parseRunEvidenceManifest(fixture)
    // Then: the failure remains typed and non-throwing.
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: RunEvidenceParseResultKind.Failure,
        record: RunEvidenceRecordKind.Manifest
      }
    })
  })
})
