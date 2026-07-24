import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceClusterConfigState,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePhaseStatus,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceIteration,
  parseRunEvidenceManifest,
  parseRunEvidenceSetup,
  parseRunEvidenceTerminal,
  verifyRunEvidence,
  type RunEvidenceIteration,
  type RunEvidenceEndpoint,
  type RunEvidenceManifest,
  type RunEvidenceParseResult,
  type RunEvidenceSetup,
  type RunEvidenceTerminal,
  type RunEvidenceVerificationReport
} from "@wireio/test-opp-stress"

import type { SchemaRampHarness } from "./stressRampSchemaV1TestSupport.js"

const Sha256Pattern = /^[0-9a-f]{64}$/,
  LegacyIterationPattern = /^iteration-\d+\.json$/

/** Parsed schema-v1 records for one completed ramp run. */
export type ParsedRampEvidence = {
  readonly setup: RunEvidenceSetup
  readonly iterations: readonly RunEvidenceIteration[]
  readonly terminal: RunEvidenceTerminal
  readonly manifest: RunEvidenceManifest
}

/** Expected persisted and independently recomputed iteration decision. */
export type RampIterationExpectation = {
  readonly accountCount: number
  readonly outcome: RunEvidenceIterationOutcome
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
}

/** Expected clean terminal decision for a generic ramp scenario. */
export type RampEvidenceExpectation = {
  readonly iterations: readonly RampIterationExpectation[]
  readonly terminal: {
    readonly lifecycle:
      RunEvidenceLifecycle.Saturated | RunEvidenceLifecycle.Incomplete
    readonly preserveCluster: boolean
    readonly verdict:
      | RunEvidenceVerificationVerdict.Saturated
      | RunEvidenceVerificationVerdict.NonSuccess
  }
}

/** Parsed records plus their independent verifier report. */
export type VerifiedRampEvidence = ParsedRampEvidence & {
  readonly report: RunEvidenceVerificationReport
}

/** Read every declared schema-v1 record through its public parser. @param runDirectory Completed run directory. @returns Typed lifecycle records. */
export function readRampEvidence(runDirectory: string): ParsedRampEvidence {
  const manifest = requireParsed(
      parseRunEvidenceManifest(
        readJson(Path.join(runDirectory, RunEvidencePath.Manifest))
      ),
      "manifest"
    ),
    setup = requireParsed(
      parseRunEvidenceSetup(
        readJson(Path.join(runDirectory, RunEvidencePath.Setup))
      ),
      "setup"
    ),
    iterations = manifest.records.iterations.map(ref =>
      requireParsed(
        parseRunEvidenceIteration(readJson(Path.join(runDirectory, ref.path))),
        ref.path
      )
    ),
    terminal = requireParsed(
      parseRunEvidenceTerminal(
        readJson(Path.join(runDirectory, RunEvidencePath.Terminal))
      ),
      "terminal"
    )
  return { setup, iterations, terminal, manifest }
}

/**
 * Assert the shared schema-v1 filesystem, record, and artifact invariants.
 *
 * @param harness Active schema persistence harness for the completed run.
 * @param evidence Public-parser-backed records to inspect.
 */
export function expectRampEvidenceLayout(
  harness: SchemaRampHarness,
  evidence: ParsedRampEvidence
): void {
  const { setup, iterations, terminal, manifest } = evidence,
    setupRef = manifest.records.setup,
    terminalRef = manifest.records.terminal,
    expectedIterationPaths = iterations.map(
      (_, index) =>
        `${RunEvidencePath.Iterations}/${String(index).padStart(6, "0")}.json`
    )
  expect(setup).toMatchObject({
    stage: RunEvidenceStage.Setup,
    status: RunEvidenceSetupStatus.Succeeded,
    clusterConfigCreated: true
  })
  if (!("path" in setupRef)) throw new Error("committed setup ref expected")
  expect(setupRef.path).toBe(RunEvidencePath.Setup)
  expectSha256(setupRef.sha256)
  if (
    manifest.clusterConfigSnapshot.kind !==
    RunEvidenceClusterConfigState.Captured
  )
    throw new Error("captured cluster config expected")
  expectSha256(manifest.clusterConfigSnapshot.sha256)
  expect(manifest.records.iterations.map(ref => ref.path)).toEqual(
    expectedIterationPaths
  )
  manifest.records.iterations.forEach(ref => expectSha256(ref.sha256))
  iterations.forEach((iteration, index) =>
    expect(iteration).toMatchObject({
      stage: RunEvidenceStage.Iteration,
      iterationIndex: index
    })
  )
  expect(terminal.stage).toBe(RunEvidenceStage.Terminal)
  expect(terminal.iterationRefs).toEqual(manifest.records.iterations)
  if (terminalRef === null) throw new Error("committed terminal ref expected")
  expect(terminalRef.path).toBe(RunEvidencePath.Terminal)
  expectSha256(terminalRef.sha256)
  if (
    manifest.lifecycle !== RunEvidenceLifecycle.Saturated &&
    manifest.lifecycle !== RunEvidenceLifecycle.Incomplete
  )
    throw new Error("clean terminal manifest expected")
  manifest.artifacts.forEach(artifact => {
    expectSha256(artifact.firstImmutableRefs.data.sha256)
    expectSha256(artifact.firstImmutableRefs.metadata.sha256)
  })
  iterations
    .flatMap(iteration => iteration.phases)
    .forEach(phase => {
      expect(phase.status).toBe(RunEvidencePhaseStatus.Completed)
      expect(phase.artifactRefs.length).toBeGreaterThan(0)
      expect(phase.artifactRefs.length % 2).toBe(0)
      phase.artifactRefs
        .filter((_, index) => index % 2 === 0)
        .forEach((dataPath, pairIndex) => {
          const metadataPath = phase.artifactRefs[pairIndex * 2 + 1],
            owner = manifest.artifacts.find(
              artifact =>
                artifact.firstImmutableRefs.data.path === dataPath &&
                artifact.firstImmutableRefs.metadata.path === metadataPath
            )
          expect(owner).toBeDefined()
        })
    })
  expect(
    Fs.readdirSync(harness.persistence.runDirectory).filter(file =>
      LegacyIterationPattern.test(file)
    )
  ).toEqual([])
  expect(
    Fs.readdirSync(harness.workspace.evidenceRoot).filter(file =>
      LegacyIterationPattern.test(file)
    )
  ).toEqual([])
}

/**
 * Parse, assert, and independently verify one clean generic ramp run.
 *
 * @param harness Active schema persistence harness for the completed run.
 * @param expected Expected controller decisions and terminal verifier verdict.
 * @returns Typed records and the valid offline verifier report.
 */
export function expectVerifiedRampEvidence(
  harness: SchemaRampHarness,
  expected: RampEvidenceExpectation
): VerifiedRampEvidence {
  const evidence = readRampEvidence(harness.persistence.runDirectory)
  expectRampEvidenceLayout(harness, evidence)
  expect(evidence.iterations).toHaveLength(expected.iterations.length)
  evidence.iterations.forEach((iteration, index) =>
    expect(iteration).toMatchObject(expected.iterations[index])
  )
  const last = expected.iterations.at(-1)
  if (last === undefined) throw new Error("iteration expectation required")
  expect(evidence.terminal).toMatchObject({
    lifecycle: expected.terminal.lifecycle,
    preserveCluster: expected.terminal.preserveCluster,
    saturatedEndpoints: last.saturatedEndpoints,
    missingEndpoints: last.missingEndpoints
  })
  expect(evidence.manifest).toMatchObject({
    lifecycle: expected.terminal.lifecycle,
    preserveCluster: expected.terminal.preserveCluster,
    saturatedEndpoints: last.saturatedEndpoints,
    missingEndpoints: last.missingEndpoints
  })
  const report = verifyRunEvidence(harness.persistence.runDirectory)
  expect(report).toMatchObject({
    valid: true,
    verdict: expected.terminal.verdict,
    lifecycle: expected.terminal.lifecycle,
    verifiedSaturated:
      expected.terminal.verdict === RunEvidenceVerificationVerdict.Saturated
  })
  expect(
    report.recomputedIterations.map(iteration => ({
      iterationIndex: iteration.iterationIndex,
      accountCount: iteration.accountCount,
      saturatedEndpoints: iteration.saturatedEndpoints,
      missingEndpoints: iteration.missingEndpoints
    }))
  ).toEqual(
    expected.iterations.map((iteration, iterationIndex) => ({
      iterationIndex,
      accountCount: iteration.accountCount,
      saturatedEndpoints: iteration.saturatedEndpoints,
      missingEndpoints: iteration.missingEndpoints
    }))
  )
  expect(
    report.recomputedEndpoints.map(endpoint => ({
      endpoint: endpoint.endpoint,
      saturated: endpoint.saturated
    }))
  ).toEqual(
    evidence.terminal.requiredEndpoints.map(endpoint => ({
      endpoint,
      saturated: last.saturatedEndpoints.includes(endpoint)
    }))
  )
  return { ...evidence, report }
}

function readJson(file: string): unknown {
  return JSON.parse(Fs.readFileSync(file, "utf8"))
}

function requireParsed<T>(parsed: RunEvidenceParseResult<T>, label: string): T {
  if (!parsed.ok) throw new Error(`${label} must parse`)
  return parsed.value
}

function expectSha256(value: string): void {
  expect(value).toMatch(Sha256Pattern)
}
