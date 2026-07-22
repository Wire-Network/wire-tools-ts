import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  OppStressRampEvidenceModeKind,
  OppStressRampTelemetryIntegrityError,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidencePath,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceIteration,
  parseRunEvidenceTerminal,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createSchemaRampHarness } from "./stressRampSchemaV1TestSupport.js"

const Endpoint = RunEvidenceEndpoint.OutpostEthereumDepot,
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp telemetry immutability", () => {
  it("survives mutation attempts while iteration publication is blocked", async () => {
    // Given: publication pauses after the failure decision captures typed telemetry.
    const harness = await createSchemaRampHarness(Config, [Endpoint]),
      source = degradedTelemetry(),
      cause = new OppStressRampTelemetryIntegrityError(
        "telemetry failed",
        source
      ),
      expectedTelemetry = structuredClone(cause.telemetry),
      publicationEntered = Promise.withResolvers<void>(),
      publicationRelease = Promise.withResolvers<void>(),
      publishIteration = harness.persistence.publishIteration.bind(
        harness.persistence
      )
    jest
      .spyOn(harness.persistence, "publishIteration")
      .mockImplementation(async record => {
        publicationEntered.resolve()
        await publicationRelease.promise
        return publishIteration(record)
      })
    try {
      const clock = jest.fn().mockReturnValueOnce(103).mockReturnValueOnce(104)

      // When: mutation is attempted while the persistence call is queued.
      const run = runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock,
        runIteration: () => Promise.reject(cause)
      })
      await publicationEntered.promise
      source.issues[0].context.storageDir = "/source-mutated"
      const issue = cause.telemetry.issues[0],
        bindingReplaced = Reflect.set(cause, "telemetry", degradedTelemetry()),
        nestedMutated = Reflect.set(
          issue.context,
          "storageDir",
          "/captured-mutated"
        )
      let redefineError: unknown = null
      try {
        Object.defineProperty(cause, "telemetry", {
          value: degradedTelemetry()
        })
      } catch (error) {
        redefineError = error
      }
      publicationRelease.resolve()
      const result = await run

      // Then: returned and persisted telemetry remains byte-equivalent and valid.
      expect(bindingReplaced).toBe(false)
      expect(nestedMutated).toBe(false)
      expect(redefineError).toBeInstanceOf(TypeError)
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        cause,
        breakageCategory: RampBreakageCategory.TelemetryIntegrity,
        telemetry: expectedTelemetry
      })
      const iteration = readIteration(harness.persistence.runDirectory),
        terminal = readTerminal(harness.persistence.runDirectory)
      expect(iteration.telemetry).toEqual(expectedTelemetry)
      expect(terminal.telemetry).toEqual(expectedTelemetry)
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject(
        {
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          verifiedSaturated: false
        }
      )
    } finally {
      publicationRelease.resolve()
      harness.cleanup()
    }
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

function readIteration(runDirectory: string) {
  const parsed = parseRunEvidenceIteration(
    JSON.parse(
      Fs.readFileSync(
        Path.join(runDirectory, RunEvidencePath.Iterations, "000000.json"),
        "utf8"
      )
    )
  )
  if ("error" in parsed) throw new Error("iteration fixture must parse")
  return parsed.value
}

function readTerminal(runDirectory: string) {
  const parsed = parseRunEvidenceTerminal(
    JSON.parse(
      Fs.readFileSync(Path.join(runDirectory, RunEvidencePath.Terminal), "utf8")
    )
  )
  if ("error" in parsed) throw new Error("terminal fixture must parse")
  return parsed.value
}
