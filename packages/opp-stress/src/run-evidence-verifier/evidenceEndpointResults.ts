import { canonicalEvidenceJson } from "../run-evidence/canonicalEvidenceJson.js"
import type {
  RunEvidenceEndpoint,
  RunEvidenceEndpointResult,
  RunEvidenceIteration
} from "../runEvidenceTypes.js"
import { RunEvidenceVerificationIssueCode } from "../runEvidenceVerifierTypes.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

/** Healthy endpoint results captured only when raw phases establish saturation. */
export type RetainedEndpointResults = Map<
  RunEvidenceEndpoint,
  RunEvidenceEndpointResult
>

/** Project the expected campaign results after raw-backed current saturation. */
export function campaignEndpointResults(
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  iteration: RunEvidenceIteration,
  newlySaturated: readonly RunEvidenceEndpoint[],
  retained: RetainedEndpointResults
): readonly RunEvidenceEndpointResult[] {
  newlySaturated.forEach(endpoint => {
    if (retained.has(endpoint)) return
    const current = iteration.endpointResults.find(
      result => result.endpoint === endpoint
    )
    if (current !== undefined) retained.set(endpoint, current)
  })
  return requiredEndpoints.flatMap(endpoint => {
    const expected =
      retained.get(endpoint) ??
      iteration.endpointResults.find(result => result.endpoint === endpoint)
    return expected === undefined ? [] : [expected]
  })
}

/** Report any saturated endpoint result that differs from retained campaign state. */
export function verifyRetainedEndpointResults(
  actual: readonly RunEvidenceEndpointResult[],
  expected: readonly RunEvidenceEndpointResult[],
  path: string,
  context: RunEvidenceVerificationContext
): void {
  expected
    .filter(result => result.saturated)
    .forEach(result => {
      const actualResult = actual.find(
        candidate => candidate.endpoint === result.endpoint
      )
      if (
        actualResult === undefined ||
        !sameEndpointResult(actualResult, result)
      )
        context.issue(
          RunEvidenceVerificationIssueCode.IterationMismatch,
          path,
          `retained endpoint result differs for ${result.endpoint}`
        )
    })
}

/** Compare complete endpoint-result arrays using canonical schema bytes. */
export function sameEndpointResults(
  left: readonly RunEvidenceEndpointResult[],
  right: readonly RunEvidenceEndpointResult[]
): boolean {
  return canonicalEvidenceJson(left).equals(canonicalEvidenceJson(right))
}

function sameEndpointResult(
  left: RunEvidenceEndpointResult,
  right: RunEvidenceEndpointResult
): boolean {
  return canonicalEvidenceJson(left).equals(canonicalEvidenceJson(right))
}
