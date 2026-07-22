import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceIteration,
  parseRunEvidenceTerminal,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createSchemaRampHarness } from "./stressRampSchemaV1TestSupport.js"

const Endpoint = RunEvidenceEndpoint.OutpostEthereumDepot,
  FailureReasonFallback = "OPP stress ramp callback failed without a reason",
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp rejection traps", () => {
  it.each([
    ["Error message accessor", errorMessageAccessorCause],
    ["proxy getPrototypeOf", proxyPrototypeCause],
    ["hostile coercion", hostileCoercionCause]
  ] as const)("finalizes %s as infrastructure", async (_, createCause) => {
    // Given: a real schema run receives a trap-bearing rejected value.
    const harness = await createSchemaRampHarness(Config, [Endpoint]),
      trapped = createCause()
    try {
      // When: callback classification and reason rendering inspect the cause.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: jest.fn().mockReturnValueOnce(103).mockReturnValueOnce(104),
        runIteration: () => Promise.reject(trapped.cause)
      })

      // Then: traps stay dormant and canonical failed evidence uses the fallback.
      const summary = result.iterations[0]
      if (summary === undefined || !("cause" in summary))
        throw new Error("boundary failure summary expected")
      expect(summary.breakageCategory).toBe(RampBreakageCategory.Infrastructure)
      expect(summary.breakageReason).toBe(FailureReasonFallback)
      expect(summary.cause).toBe(trapped.cause)
      expect(trapped.calls()).toBe(0)
      const iteration = readIteration(harness.persistence.runDirectory),
        terminal = readTerminal(harness.persistence.runDirectory)
      expect(iteration).toMatchObject({
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: FailureReasonFallback
      })
      expect(terminal).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: FailureReasonFallback
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
})

type TrappedCause = {
  readonly cause: unknown
  readonly calls: () => number
}

function errorMessageAccessorCause(): TrappedCause {
  let calls = 0
  const cause = new Error()
  Object.defineProperty(cause, "message", {
    configurable: true,
    get: () => {
      calls += 1
      throw new Error("MESSAGE_SENTINEL")
    }
  })
  return { cause, calls: () => calls }
}

function proxyPrototypeCause(): TrappedCause {
  let calls = 0
  const cause = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        calls += 1
        throw new Error("PROTOTYPE_SENTINEL")
      }
    }
  )
  return { cause, calls: () => calls }
}

function hostileCoercionCause(): TrappedCause {
  let calls = 0
  const trap = () => {
      calls += 1
      throw new Error("COERCION_SENTINEL")
    },
    cause = {
      toString: trap,
      valueOf: trap,
      [Symbol.toPrimitive]: trap
    }
  return { cause, calls: () => calls }
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
