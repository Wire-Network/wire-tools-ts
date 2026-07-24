import type {
  OppStressRampDeferredEvidenceCompletedObservation,
  OppStressRampDeferredEvidenceParseContext
} from "@wireio/test-opp-stress"

import { RequiredEndpoints } from "./stressRampContractTestSupport.js"

/** Minimal typed payload used to exercise generic deferred transport. */
export type TestEvidence = {
  readonly phaseResults: readonly string[]
}

/** Create one exact completed generic observation fixture. */
export function completedEvidenceObservation(
  phaseResults: readonly string[]
): OppStressRampDeferredEvidenceCompletedObservation<TestEvidence> {
  return {
    kind: "completed",
    saturatedEndpoints: RequiredEndpoints,
    observedNonRequiredEndpoints: [],
    evidence: { phaseResults }
  }
}

/** Parse the exact minimal evidence fixture from a safe snapshot. */
export function parseTestEvidence(
  input: unknown,
  _context: OppStressRampDeferredEvidenceParseContext
): TestEvidence | null {
  if (!isRecord(input) || !hasExactKeys(input, ["phaseResults"])) return null
  const phaseResults = input.phaseResults
  return Array.isArray(phaseResults) &&
    phaseResults.every(value => typeof value === "string")
    ? { phaseResults: [...phaseResults] }
    : null
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value)
  return (
    actual.length === keys.length &&
    actual.every(key => typeof key === "string" && keys.includes(key))
  )
}
