import * as OppStress from "@wireio/test-opp-stress"

type ExactVerifierParameters =
  Parameters<typeof OppStress.verifyRunEvidence> extends [string]
    ? [string] extends Parameters<typeof OppStress.verifyRunEvidence>
      ? true
      : false
    : false

describe("run evidence verifier public surface", () => {
  it("exports the offline schema-v1 verifier", () => {
    // Given: the package-root public API.
    const verifier = Reflect.get(OppStress, "verifyRunEvidence"),
      hasExactParameters: ExactVerifierParameters = true

    // When/Then: Todo 9 exposes only the one-run-directory consumer signature.
    expect(typeof verifier).toBe("function")
    expect(verifier).toHaveLength(1)
    expect(hasExactParameters).toBe(true)
  })

  it("does not export verifier filesystem identity internals", () => {
    // Given: the package-root consumer surface.
    const identity = Reflect.get(OppStress, "verifierIdentity"),
      comparator = Reflect.get(OppStress, "sameVerifierIdentity")

    // When/Then: descriptor implementation helpers remain package-private.
    expect(identity).toBeUndefined()
    expect(comparator).toBeUndefined()
  })

  it("does not export verifier test dependencies", () => {
    // Given: the package-root consumer surface.
    const testNamespace = Reflect.get(OppStress, "RunEvidenceVerifier"),
      testHook = Reflect.get(OppStress, "afterFileRead")

    // When/Then: deterministic race machinery remains entirely in Jest.
    expect(testNamespace).toBeUndefined()
    expect(testHook).toBeUndefined()
  })
})
