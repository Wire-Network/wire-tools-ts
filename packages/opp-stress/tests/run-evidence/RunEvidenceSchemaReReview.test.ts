import * as OppStress from "@wireio/test-opp-stress"

import {
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSetupRefState
} from "@wireio/test-opp-stress"

import {
  artifactEntry,
  capturedSnapshot,
  committedRecordRefs,
  completedPhase,
  degradedTelemetry,
  EvidenceEndpoint,
  EvidenceRecordSha256,
  healthyTelemetry,
  initializingManifest,
  saturatedIteration,
  saturatedTerminal,
  setupRecordRef,
  terminalRecordRef
} from "./runEvidenceSchemaFixtures.js"

const saturatedManifest = {
    ...initializingManifest,
    lifecycle: RunEvidenceLifecycle.Saturated,
    clusterConfigSnapshot: capturedSnapshot,
    saturatedEndpoints: [EvidenceEndpoint],
    missingEndpoints: [],
    preserveCluster: false,
    telemetry: healthyTelemetry,
    records: committedRecordRefs,
    artifacts: [artifactEntry]
  },
  PublicSchemaParserNames = [
    "parseRunEvidenceArtifact",
    "parseRunEvidenceIteration",
    "parseRunEvidenceManifest",
    "parseRunEvidenceProvenance",
    "parseRunEvidenceSetup",
    "parseRunEvidenceTerminal"
  ].sort()

describe("schema-v1 first re-review corrections", () => {
  it.each([
    ["explicit pending setup", initializingManifest],
    ["immutable committed lifecycle files", saturatedManifest]
  ])("accepts manifests with %s refs", (_label, fixture) => {
    // Given: lifecycle refs with explicit pending or committed digest state.
    // When: the manifest crosses the schema boundary.
    const result = OppStress.parseRunEvidenceManifest(fixture)
    // Then: the immutable ref layout is accepted unchanged.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it.each([
    [
      "pending setup carrying a digest",
      {
        ...initializingManifest,
        records: {
          ...initializingManifest.records,
          setup: {
            kind: RunEvidenceSetupRefState.Pending,
            sha256: EvidenceRecordSha256
          }
        }
      }
    ],
    [
      "committed setup with a short digest",
      {
        ...saturatedManifest,
        records: {
          ...committedRecordRefs,
          setup: { ...setupRecordRef, sha256: "abc" }
        }
      }
    ],
    [
      "gapped iteration path",
      {
        ...saturatedManifest,
        records: {
          ...committedRecordRefs,
          iterations: [
            {
              path: `${RunEvidencePath.Iterations}/000001.json`,
              sha256: EvidenceRecordSha256
            }
          ]
        }
      }
    ],
    [
      "terminal with an uppercase digest",
      {
        ...saturatedManifest,
        records: {
          ...committedRecordRefs,
          terminal: {
            ...terminalRecordRef,
            sha256: EvidenceRecordSha256.toUpperCase()
          }
        }
      }
    ]
  ])("rejects %s", (_label, fixture) => {
    // Given: a lifecycle ref that cannot target immutable canonical bytes.
    // When: the manifest parser validates the ref.
    const result = OppStress.parseRunEvidenceManifest(fixture)
    // Then: malformed pending, path, or digest state is rejected.
    expect(result.ok).toBe(false)
  })

  it("rejects a completed not-saturated iteration with a degraded endpoint", () => {
    // Given: aggregate telemetry is healthy but the missing endpoint is degraded.
    const fixture = {
      ...saturatedIteration,
      outcome: RunEvidenceIterationOutcome.NotSaturated,
      saturatedEndpoints: [],
      missingEndpoints: [EvidenceEndpoint],
      endpointResults: [
        {
          endpoint: EvidenceEndpoint,
          telemetry: degradedTelemetry,
          saturated: false
        }
      ],
      phases: [
        {
          ...completedPhase,
          metrics: { ...completedPhase.metrics, saturated: false }
        }
      ]
    }
    // When: the clean completed iteration is parsed.
    const result = OppStress.parseRunEvidenceIteration(fixture)
    // Then: persistent non-healthy endpoint evidence cannot look completed.
    expect(result.ok).toBe(false)
  })

  it("rejects an incomplete terminal with a degraded endpoint", () => {
    // Given: an incomplete terminal whose aggregate is healthy but endpoint is degraded.
    const fixture = {
      ...saturatedTerminal,
      lifecycle: RunEvidenceLifecycle.Incomplete,
      saturatedEndpoints: [],
      missingEndpoints: [EvidenceEndpoint],
      endpointResults: [
        {
          endpoint: EvidenceEndpoint,
          telemetry: degradedTelemetry,
          saturated: false
        }
      ],
      preserveCluster: true
    }
    // When: the clean terminal decision is parsed.
    const result = OppStress.parseRunEvidenceTerminal(fixture)
    // Then: persistent non-healthy endpoint evidence requires breakage.
    expect(result.ok).toBe(false)
  })

  it("exposes exactly six public schema parsers and no internal guards", () => {
    // Given: the consumer-visible package namespace.
    const publicNames = Object.keys(OppStress)
    // When: schema parser and internal guard names are selected.
    const parserNames = publicNames
        .filter(name => name.startsWith("parseRunEvidence"))
        .sort(),
      leakedNames = [
        "isArtifact",
        "isArtifactEntries",
        "isArtifactRef",
        "isArtifactRefs",
        "isProvenance"
      ].filter(name => publicNames.includes(name))
    // Then: the package exposes the intended minimal runtime schema API.
    expect(parserNames).toEqual(PublicSchemaParserNames)
    expect(leakedNames).toEqual([])
  })
})
