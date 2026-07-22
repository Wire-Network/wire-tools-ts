import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppStressRampEvidenceModeKind,
  OppStressRampTelemetryIntegrityError,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceIteration,
  parseRunEvidenceManifest,
  parseRunEvidenceTerminal,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { degradedTelemetry } from "./run-evidence/runEvidenceSchemaFixtures.js"
import {
  createSchemaRampHarness,
  schemaObservation
} from "./stressRampSchemaV1TestSupport.js"

const EndpointA = RunEvidenceEndpoint.OutpostEthereumDepot,
  EndpointB = RunEvidenceEndpoint.DepotOutpostEthereum,
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 4,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp controller failures", () => {
  it("persists exact typed degraded telemetry", async () => {
    // Given: a typed callback failure owns a parsed degraded telemetry snapshot.
    const harness = await createSchemaRampHarness(Config, [EndpointA]),
      cause = new OppStressRampTelemetryIntegrityError(
        "strict telemetry failed",
        degradedTelemetry
      )
    try {
      // When: the callback rejects before producing an observation.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: sequenceClock(103, 104),
        runIteration: () => Promise.reject(cause)
      })

      // Then: iteration, terminal, result, and verifier retain one classification.
      const records = readRecords(harness.persistence.runDirectory, 0)
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        cause,
        telemetry: cause.telemetry,
        breakageCategory: RampBreakageCategory.TelemetryIntegrity,
        breakageReason: "strict telemetry failed"
      })
      expect(records.iteration).toMatchObject({
        outcome: RunEvidenceIterationOutcome.Breakage,
        phases: [],
        telemetry: cause.telemetry,
        breakageCategory: RampBreakageCategory.TelemetryIntegrity
      })
      expect(records.terminal).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        telemetry: cause.telemetry,
        breakageCategory: RampBreakageCategory.TelemetryIntegrity
      })
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject(
        {
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          verifiedSaturated: false
        }
      )
    } finally {
      harness.cleanup()
    }
  })

  it("retains prior healthy endpoint telemetry after later rejection", async () => {
    // Given: the first persisted iteration saturates only the first endpoint.
    const harness = await createSchemaRampHarness(Config, [
        EndpointA,
        EndpointB
      ]),
      cause = new Error("second callback failed")
    try {
      // When: the next callback rejects before producing observation data.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: sequenceClock(103, 104, 105, 106),
        runIteration: input =>
          input.iterationIndex === 0
            ? schemaObservation({
                ...harness,
                requiredEndpoints: [EndpointA, EndpointB],
                iterationIndex: input.iterationIndex,
                accountCount: input.accountCount,
                saturatedEndpoints: [EndpointA]
              })
            : Promise.reject(cause)
      })

      // Then: the failed record partitions endpoints and retains only proven health.
      const first = readIteration(harness.persistence.runDirectory, 0),
        second = readIteration(harness.persistence.runDirectory, 1),
        terminal = readTerminal(harness.persistence.runDirectory)
      expect(result).toMatchObject({
        status: "failed_before_saturation",
        preserveCluster: true,
        saturatedEndpoints: [EndpointA],
        missingEndpoints: [EndpointB]
      })
      expect(result.iterations[1]).toMatchObject({
        observation: null,
        cause
      })
      expect(second.phases).toEqual([])
      expect(second.endpointResults[0]).toEqual(first.endpointResults[0])
      expect(second.endpointResults[1]).toMatchObject({
        endpoint: EndpointB,
        saturated: false,
        telemetry: { kind: "empty", retryable: true, issueCount: 0 }
      })
      expect(terminal.iterationRefs.map(ref => ref.path)).toEqual([
        `${RunEvidencePath.Iterations}/000000.json`,
        `${RunEvidencePath.Iterations}/000001.json`
      ])
      expect(terminal.endpointResults).toEqual(second.endpointResults)
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject(
        {
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess
        }
      )
    } finally {
      harness.cleanup()
    }
  })

  it.each([
    ["invalid start", [-1], 0],
    ["invalid end", [10, -1], 1],
    ["reversed end", [10, 9], 1]
  ] as const)(
    "propagates %s clock without lifecycle records",
    async (_, values, calls) => {
      // Given: an active run has a clock sequence that cannot form truthful decimals.
      const harness = await createSchemaRampHarness(Config, [EndpointA]),
        runIteration = jest.fn(() =>
          Promise.reject(new Error("callback failed"))
        ),
        clock = sequenceClock(...values)
      try {
        // When: the controller reaches the impossible clock boundary.
        const run = runOppStressRamp({
          evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
          persistence: harness.persistence,
          clock,
          runIteration
        })

        // Then: the clock error propagates and no iteration or terminal is published.
        await expect(run).rejects.toBeInstanceOf(Error)
        expect(runIteration).toHaveBeenCalledTimes(calls)
        const manifest = readManifest(harness.persistence.runDirectory)
        expect(manifest.lifecycle).toBe(RunEvidenceLifecycle.Running)
        expect(manifest.records.iterations).toEqual([])
        expect(manifest.records.terminal).toBeNull()
        expect(
          Fs.readdirSync(
            Path.join(
              harness.persistence.runDirectory,
              RunEvidencePath.Iterations
            )
          )
        ).toEqual([])
        expect(
          Fs.existsSync(
            Path.join(
              harness.persistence.runDirectory,
              RunEvidencePath.Terminal
            )
          )
        ).toBe(false)
      } finally {
        harness.cleanup()
      }
    }
  )
})

function sequenceClock(...values: readonly number[]): jest.Mock<number, []> {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}

function readRecords(runDirectory: string, iterationIndex: number) {
  return {
    iteration: readIteration(runDirectory, iterationIndex),
    terminal: readTerminal(runDirectory)
  }
}

function readIteration(runDirectory: string, iterationIndex: number) {
  const parsed = parseRunEvidenceIteration(
    readJson(
      Path.join(
        runDirectory,
        RunEvidencePath.Iterations,
        `${String(iterationIndex).padStart(6, "0")}.json`
      )
    )
  )
  if ("error" in parsed) throw new Error("iteration fixture must parse")
  return parsed.value
}

function readTerminal(runDirectory: string) {
  const parsed = parseRunEvidenceTerminal(
    readJson(Path.join(runDirectory, RunEvidencePath.Terminal))
  )
  if ("error" in parsed) throw new Error("terminal fixture must parse")
  return parsed.value
}

function readManifest(runDirectory: string) {
  const parsed = parseRunEvidenceManifest(
    readJson(Path.join(runDirectory, RunEvidencePath.Manifest))
  )
  if ("error" in parsed) throw new Error("manifest fixture must parse")
  return parsed.value
}

function readJson(file: string): unknown {
  return JSON.parse(Fs.readFileSync(file, "utf8"))
}
