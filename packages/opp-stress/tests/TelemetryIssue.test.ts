import { EnvelopeIntegrityIssueCode } from "@wireio/debugging-shared"
import {
  mapEnvelopeIntegrityIssue,
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  OppEnvelopeTelemetryIssueCode,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

import {
  GlobalIntegrityIssueCodes,
  IntegrityIssueFixtures
} from "./telemetryIssueTestFixtures.js"

describe("telemetry integrity issue mapping and parsing", () => {
  it.each(IntegrityIssueFixtures)(
    "maps and parses the strict $code issue losslessly",
    strictIssue => {
      // Given: one exact strict-reader issue variant.
      const isGlobal = GlobalIntegrityIssueCodes.some(
          code => code === strictIssue.code
        ),
        mapped = mapEnvelopeIntegrityIssue(strictIssue),
        health = {
          kind: isGlobal
            ? OppEnvelopeTelemetryHealthKind.Empty
            : OppEnvelopeTelemetryHealthKind.PendingPublication,
          retryable: true,
          candidateCount: isGlobal ? 0 : 1,
          validCount: 0,
          filteredCount: 0,
          issueCount: 1,
          issues: [mapped]
        }

      // When: the mapped issue crosses the exact telemetry parser boundary.
      const parsed = parseOppEnvelopeTelemetryHealth(health)

      // Then: code, scope key, and structured context remain byte-for-byte data equivalents.
      expect(mapped).toEqual(strictIssue)
      expect(parsed.issues).toEqual([mapped])
      expect(JSON.parse(JSON.stringify(mapped))).toEqual(mapped)
    }
  )

  it("covers all 25 strict and telemetry issue codes exactly once", () => {
    // Given: the exhaustive strict fixture matrix and both closed code enums.

    // When: their serialized code strings are sorted.
    const fixtureCodes = IntegrityIssueFixtures.map(issue => issue.code).sort(),
      strictCodes = Object.values(EnvelopeIntegrityIssueCode).sort(),
      telemetryCodes = Object.values(OppEnvelopeTelemetryIssueCode).sort()

    // Then: no strict classification is normalized, dropped, or duplicated.
    expect(fixtureCodes).toHaveLength(25)
    expect(fixtureCodes).toEqual(strictCodes)
    expect(telemetryCodes).toEqual(strictCodes)
  })

  it("accepts an empty malformed-candidate base key", () => {
    // Given: the strict invalid-key fixture whose discovered base key is empty.
    const issue = mapEnvelopeIntegrityIssue(IntegrityIssueFixtures[0])

    // When: pending candidate health is parsed.
    const parsed = parseOppEnvelopeTelemetryHealth({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount: 1,
      validCount: 0,
      filteredCount: 0,
      issueCount: 1,
      issues: [issue]
    })

    // Then: the malformed key is preserved rather than replaced by a policy label.
    expect(parsed.issues[0]?.baseKey).toBe("")
  })

  it("rejects a global issue outside the $storage scope", () => {
    // Given: an otherwise exact global issue with a candidate-like scope key.
    const globalIssue = mapEnvelopeIntegrityIssue(
        IntegrityIssueFixtures[IntegrityIssueFixtures.length - 1]
      ),
      health = {
        kind: OppEnvelopeTelemetryHealthKind.Empty,
        retryable: true,
        candidateCount: 0,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [{ ...globalIssue, baseKey: "candidate" }]
      }

    // When: exact telemetry parsing is attempted.
    const parse = () => parseOppEnvelopeTelemetryHealth(health)

    // Then: scope classification comes from the code and rejects the wrong key.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })

  it("rejects a legacy file-error shape", () => {
    // Given: a read issue that omits strict code and operation diagnostics.
    const readIssue = mapEnvelopeIntegrityIssue(IntegrityIssueFixtures[8]),
      health = {
        kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
        retryable: true,
        candidateCount: 1,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [
          {
            ...readIssue,
            context: {
              path: "/tmp/sidecar",
              error: { name: "Error", message: "legacy" }
            }
          }
        ]
      }

    // When: exact telemetry parsing is attempted.
    const parse = () => parseOppEnvelopeTelemetryHealth(health)

    // Then: no legacy context alternative is accepted.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })
})
