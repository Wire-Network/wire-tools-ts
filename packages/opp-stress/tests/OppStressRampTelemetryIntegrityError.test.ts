import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  OppStressRampTelemetryIntegrityError
} from "@wireio/test-opp-stress"

describe("OppStressRampTelemetryIntegrityError", () => {
  it("snapshots parser-valid degraded telemetry", () => {
    // Given: mutable but coherent degraded telemetry from a callback boundary.
    const telemetry = degradedTelemetry()

    // When: the typed error captures it and the caller later mutates its source.
    const error = new OppStressRampTelemetryIntegrityError(
      "telemetry failed",
      telemetry
    )
    telemetry.issues[0].context.storageDir = "/mutated"

    // Then: evidence retains the detached parser-valid snapshot.
    expect(error.message).toBe("telemetry failed")
    expect(error.telemetry.issues[0].context).toMatchObject({
      storageDir: "/storage"
    })
    expect(Object.isFrozen(error.telemetry)).toBe(true)
    expect(Object.isFrozen(error.telemetry.issues)).toBe(true)
  })

  it("freezes the error binding and every nested telemetry value", () => {
    // Given: a typed error has parser-produced nested issue context.
    const error = new OppStressRampTelemetryIntegrityError(
        "telemetry failed",
        degradedTelemetry()
      ),
      issue = error.telemetry.issues[0]

    // When: callers attempt replacement, redefinition, and nested mutation.
    const replaced = Reflect.set(error, "telemetry", degradedTelemetry()),
      issueMutated = Reflect.set(issue, "baseKey", "mutated"),
      contextMutated = Reflect.set(issue.context, "storageDir", "/mutated")

    // Then: runtime descriptors reject every mutation path.
    expect(replaced).toBe(false)
    expect(issueMutated).toBe(false)
    expect(contextMutated).toBe(false)
    expect(() =>
      Object.defineProperty(error, "telemetry", {
        value: degradedTelemetry()
      })
    ).toThrow(TypeError)
    expect(Object.getOwnPropertyDescriptor(error, "telemetry")).toMatchObject({
      writable: false,
      configurable: false
    })
    expect(Object.getOwnPropertyDescriptor(error, "message")).toMatchObject({
      writable: false,
      configurable: false
    })
    expect(Object.isFrozen(error)).toBe(true)
    expect(Object.isFrozen(issue)).toBe(true)
    expect(Object.isFrozen(issue.context)).toBe(true)
  })

  it("rejects non-degraded telemetry", () => {
    // Given: empty telemetry cannot substantiate telemetry-integrity breakage.
    const telemetry = {
      kind: OppEnvelopeTelemetryHealthKind.Empty,
      retryable: true,
      candidateCount: 0,
      validCount: 0,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    }

    // When/Then: construction fails before an invalid typed error can escape.
    expect(
      () => new OppStressRampTelemetryIntegrityError("invalid", telemetry)
    ).toThrow("requires degraded health")
  })
})

function degradedTelemetry() {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Degraded,
    retryable: false,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 1,
    issues: [
      {
        code: OppEnvelopeTelemetryIssueCode.DirectoryScanFailed,
        baseKey: "$storage",
        context: {
          storageDir: "/storage",
          error: {
            name: "Error",
            code: "EIO",
            message: "scan failed",
            operation: "readdir"
          }
        }
      }
    ]
  }
}
