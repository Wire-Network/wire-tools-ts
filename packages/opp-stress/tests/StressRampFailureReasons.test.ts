import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  runOppStressRamp
} from "@wireio/test-opp-stress"

const FailureReasonFallback =
    "OPP stress ramp callback failed without a reason",
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp failure reasons", () => {
  it.each([
    [new Error("exact error message "), "exact error message "],
    [17, "OPP stress ramp callback rejected with 17"],
    ["", FailureReasonFallback]
  ])("renders callback cause %# deterministically", async (cause, reason) => {
    // Given: a callback rejects with an arbitrary JavaScript value.
    const clock = jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(11)

    // When: deferred mode classifies the callback boundary.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      config: Config,
      clock,
      runIteration: () => Promise.reject(cause)
    })

    // Then: the reason is stable and the exact in-memory cause is retained.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.Infrastructure,
      breakageReason: reason,
      cause
    })
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it("does not inspect arbitrary rejected objects", async () => {
    // Given: an object exposes an accessor that must not run during rendering.
    let getterCalls = 0
    const cause = Object.defineProperty({}, "message", {
      get: () => {
        getterCalls += 1
        return "untrusted"
      }
    })

    // When: the callback rejects with the untrusted object.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      config: Config,
      clock: jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(11),
      runIteration: () => Promise.reject(cause)
    })

    // Then: rendering uses the explicit fallback without invoking the accessor.
    expect(result.iterations[0]).toMatchObject({
      breakageReason: FailureReasonFallback,
      cause
    })
    expect(getterCalls).toBe(0)
  })
})
