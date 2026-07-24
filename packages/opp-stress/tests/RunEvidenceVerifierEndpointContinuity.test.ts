import {
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  arrayField,
  objectField,
  readVerifierJson,
  recordValue,
  refreshVerifierRecordHash,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"
import {
  createSchemaRampHarness,
  schemaObservation,
  type SchemaRampHarness
} from "./stressRampSchemaV1TestSupport.js"

const EndpointA = RunEvidenceEndpoint.OutpostEthereumDepot,
  EndpointB = RunEvidenceEndpoint.DepotOutpostEthereum,
  SecondIterationPath = `${RunEvidencePath.Iterations}/000001.json`

describe("run evidence verifier endpoint-result continuity", () => {
  it("rejects hash-consistent retained telemetry drift", async () => {
    // Given: a valid cumulative campaign retains endpoint A health after A saturated.
    const harness = await createCumulativeFixture()
    try {
      expect(verifyRunEvidence(harness.persistence.runDirectory).valid).toBe(
        true
      )
      replaceRetainedTelemetryWithCurrentPhase(
        harness.persistence.runDirectory,
        SecondIterationPath
      )
      refreshVerifierRecordHash(
        harness.persistence.runDirectory,
        SecondIterationPath
      )
      refreshTerminalIterationRefs(harness.persistence.runDirectory)

      // When: the verifier recomputes saturation from immutable phase bytes.
      const report = verifyRunEvidence(harness.persistence.runDirectory)

      // Then: changed retained telemetry is a deterministic iteration defect.
      expect(report.valid).toBe(false)
      expect(report.issues).toContainEqual({
        code: RunEvidenceVerificationIssueCode.IterationMismatch,
        path: SecondIterationPath,
        detail: `retained endpoint result differs for ${EndpointA}`
      })
    } finally {
      harness.cleanup()
    }
  })

  it("rejects hash-consistent terminal endpoint-result drift", async () => {
    // Given: a valid cumulative campaign has terminal results equal to its last iteration.
    const harness = await createCumulativeFixture()
    try {
      expect(verifyRunEvidence(harness.persistence.runDirectory).valid).toBe(
        true
      )
      const terminal = readVerifierJson(
          harness.persistence.runDirectory,
          RunEvidencePath.Terminal
        ),
        second = readVerifierJson(
          harness.persistence.runDirectory,
          SecondIterationPath
        ),
        terminalResult = recordValue(
          arrayField(terminal, "endpointResults")[0]
        ),
        currentPhase = recordValue(arrayField(second, "phases")[0])
      terminalResult["telemetry"] = objectField(currentPhase, "telemetry")
      writeVerifierJson(
        harness.persistence.runDirectory,
        RunEvidencePath.Terminal,
        terminal
      )
      refreshVerifierRecordHash(
        harness.persistence.runDirectory,
        RunEvidencePath.Terminal
      )

      // When: terminal campaign state is compared with the last iteration.
      const report = verifyRunEvidence(harness.persistence.runDirectory)

      // Then: terminal telemetry drift is a deterministic terminal defect.
      expect(report.valid).toBe(false)
      expect(report.issues).toContainEqual({
        code: RunEvidenceVerificationIssueCode.TerminalMismatch,
        path: RunEvidencePath.Terminal,
        detail: "terminal endpoint results differ from the final campaign state"
      })
    } finally {
      harness.cleanup()
    }
  })
})

async function createCumulativeFixture(): Promise<SchemaRampHarness> {
  const harness = await createSchemaRampHarness(
    {
      initialCount: 1,
      multiplier: 2,
      maxCount: 4,
      phaseTimeoutMs: 30_000
    },
    [EndpointA, EndpointB]
  )
  try {
    await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
      persistence: harness.persistence,
      clock: controllerClock(),
      runIteration: input =>
        schemaObservation({
          ...harness,
          requiredEndpoints: [EndpointA, EndpointB],
          iterationIndex: input.iterationIndex,
          accountCount: input.accountCount,
          saturatedEndpoints:
            input.iterationIndex === 0 ? [EndpointA] : [EndpointB]
        })
    })
    return harness
  } catch (error) {
    harness.cleanup()
    throw error
  }
}

function replaceRetainedTelemetryWithCurrentPhase(
  runDirectory: string,
  iterationPath: string
): void {
  const iteration = readVerifierJson(runDirectory, iterationPath),
    retained = recordValue(arrayField(iteration, "endpointResults")[0]),
    currentPhase = recordValue(arrayField(iteration, "phases")[0])
  retained["telemetry"] = objectField(currentPhase, "telemetry")
  writeVerifierJson(runDirectory, iterationPath, iteration)
}

function refreshTerminalIterationRefs(runDirectory: string): void {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    iterationRefs = arrayField(objectField(manifest, "records"), "iterations"),
    terminal = readVerifierJson(runDirectory, RunEvidencePath.Terminal)
  terminal["iterationRefs"] = iterationRefs
  writeVerifierJson(runDirectory, RunEvidencePath.Terminal, terminal)
  refreshVerifierRecordHash(runDirectory, RunEvidencePath.Terminal)
}

function controllerClock(): () => number {
  let value = 102
  return () => {
    value += 1
    return value
  }
}
