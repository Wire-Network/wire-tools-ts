import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  OppEnvelopeTelemetryIssueCode,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import type {
  DegradedOppEnvelopeTelemetryHealth,
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryIssue,
  OppEnvelopeTelemetryObservation,
  PendingOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

const HashIssue = {
    code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
    baseKey: "00000007-OUTPOST_ETHEREUM_DEPOT-0123456789abcdef",
    context: {
      expectedHashPrefix: "0123456789abcdef",
      actualHashPrefix: "fedcba9876543210",
      actualSha256: "f".repeat(64)
    }
  } satisfies OppEnvelopeTelemetryIssue,
  ScanIssue = {
    code: OppEnvelopeTelemetryIssueCode.DirectoryScanFailed,
    baseKey: "$storage",
    context: {
      storageDir: "/tmp/opp-debugging",
      error: {
        name: "Error",
        code: "ENOENT",
        message: "directory missing",
        operation: "readdir"
      }
    }
  } satisfies OppEnvelopeTelemetryIssue,
  EmptyFixture = {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } satisfies EmptyOppEnvelopeTelemetryHealth,
  PendingFixture = {
    kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
    retryable: true,
    candidateCount: 1,
    validCount: 0,
    filteredCount: 0,
    issueCount: 1,
    issues: [HashIssue]
  } satisfies PendingOppEnvelopeTelemetryHealth,
  HealthyFixture = {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount: 1,
    validCount: 1,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } satisfies HealthyOppEnvelopeTelemetryHealth,
  DegradedFixture = {
    kind: OppEnvelopeTelemetryHealthKind.Degraded,
    retryable: false,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 1,
    issues: [ScanIssue]
  } satisfies DegradedOppEnvelopeTelemetryHealth

describe("parseOppEnvelopeTelemetryHealth", () => {
  it.each([
    [OppEnvelopeTelemetryHealthKind.Empty, EmptyFixture],
    [OppEnvelopeTelemetryHealthKind.PendingPublication, PendingFixture],
    [OppEnvelopeTelemetryHealthKind.Healthy, HealthyFixture],
    [OppEnvelopeTelemetryHealthKind.Degraded, DegradedFixture]
  ])("parses the coherent %s health variant", (kind, fixture) => {
    // Given: a JSON-safe fixture for one coherent health-state variant.

    // When: the public runtime parser receives the fixture.
    const parsed = parseOppEnvelopeTelemetryHealth(fixture),
      roundTripped: unknown = JSON.parse(JSON.stringify(parsed))

    // Then: the parser preserves its discriminant and JSON-safe contract.
    expect(parsed.kind).toBe(kind)
    expect(parsed).toEqual(fixture)
    expect(roundTripped).toEqual(parsed)
  })

  it("narrows all retryable collection observations without degraded", () => {
    // Given: every state that a pre-deadline collector may return.
    const observations: readonly OppEnvelopeTelemetryObservation[] = [
      EmptyFixture,
      PendingFixture,
      HealthyFixture
    ]

    // When: callers read the collection-only discriminants.
    const kinds = observations.map(observation => observation.kind)

    // Then: degraded is absent from the collection observation union.
    expect(kinds).toEqual([
      OppEnvelopeTelemetryHealthKind.Empty,
      OppEnvelopeTelemetryHealthKind.PendingPublication,
      OppEnvelopeTelemetryHealthKind.Healthy
    ])
  })

  it.each([
    ["non-object input", null],
    ["unknown health kind", { ...HealthyFixture, kind: "unknown" }],
    ["negative count", { ...EmptyFixture, candidateCount: -1 }],
    ["fractional count", { ...EmptyFixture, issueCount: 0.5 }],
    ["issue-count mismatch", { ...EmptyFixture, issueCount: 1 }],
    [
      "more accounted records than candidates",
      { ...HealthyFixture, candidateCount: 1, validCount: 1, filteredCount: 1 }
    ],
    ["nonempty empty-state counts", { ...EmptyFixture, candidateCount: 1 }],
    ["non-retryable empty state", { ...EmptyFixture, retryable: false }],
    [
      "pending state without candidates",
      { ...PendingFixture, candidateCount: 0 }
    ],
    [
      "pending state without issues",
      { ...PendingFixture, issueCount: 0, issues: [] }
    ],
    [
      "pending state with every candidate accounted",
      { ...PendingFixture, validCount: 1 }
    ],
    ["non-retryable pending state", { ...PendingFixture, retryable: false }],
    [
      "healthy state without candidates",
      { ...HealthyFixture, candidateCount: 0 }
    ],
    [
      "healthy state with issues",
      { ...HealthyFixture, issueCount: 1, issues: [HashIssue] }
    ],
    [
      "healthy state with unaccounted candidates",
      { ...HealthyFixture, candidateCount: 2 }
    ],
    ["retryable healthy state", { ...HealthyFixture, retryable: true }],
    [
      "degraded state without issues",
      { ...DegradedFixture, issueCount: 0, issues: [] }
    ],
    ["retryable degraded state", { ...DegradedFixture, retryable: true }],
    ["unexpected health field", { ...HealthyFixture, deadlineMs: 1 }]
  ])("rejects %s", (_label, fixture) => {
    // Given: a fixture that violates the health contract.

    // When: parsing is attempted at the unknown-input boundary.
    const parse = () => parseOppEnvelopeTelemetryHealth(fixture)

    // Then: malformed or impossible state is rejected by the typed parser.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })
})
