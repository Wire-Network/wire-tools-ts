import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import type {
  OppStressRampDeferredBreakageObservation,
  OppStressRampDeferredCompletedObservation,
  OppStressRampDeferredIterationObservation
} from "@wireio/test-opp-stress"

/** Required endpoint fixture whose order differs from observation order. */
export const RequiredEndpoints = [
  RunEvidenceEndpoint.DepotOutpostEthereum,
  RunEvidenceEndpoint.OutpostEthereumDepot
] as const

/** Small deterministic ramp configuration shared by contract cases. */
export const RampConfig = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 2,
  phaseTimeoutMs: 30_000
} as const

/** Stale controller-owned fields rejected by the callback boundary. */
export const StaleFieldCases = [
  ["iterationIndex", 0],
  ["accountCount", 1],
  ["status", "running"],
  ["preserveCluster", false],
  ["missingEndpoints", []],
  ["startedAtMs", 1],
  ["endedAtMs", 2]
] as const

/** Invalid required-endpoint collections rejected before side effects. */
export const InvalidRequiredEndpointCases = [
  ["empty set", []],
  ["duplicate", ["required", "required"]],
  ["empty label", [""]]
] as const

/** Exact-shape, variant, scalar, and endpoint observations rejected by parsing. */
export const InvalidObservationCases: readonly (readonly [
  string,
  () => OppStressRampDeferredIterationObservation
])[] = [
  [
    "completed category",
    () =>
      completedWithProperty("breakageCategory", RampBreakageCategory.Workload)
  ],
  [
    "completed reason",
    () => completedWithProperty("breakageReason", "unexpected")
  ],
  ["breakage missing category", () => breakageWithout("breakageCategory")],
  ["breakage missing reason", () => breakageWithout("breakageReason")],
  ["breakage empty reason", () => breakageWithProperty("breakageReason", "")],
  [
    "breakage unknown category",
    () => breakageWithProperty("breakageCategory", "other")
  ],
  ["missing saturation", () => completedWithout("saturatedEndpoints")],
  [
    "missing diagnostics",
    () => completedWithout("observedNonRequiredEndpoints")
  ],
  [
    "duplicate saturation",
    () =>
      completedWithProperty("saturatedEndpoints", ["required-a", "required-a"])
  ],
  [
    "outside saturation",
    () => completedWithProperty("saturatedEndpoints", ["outside"])
  ],
  [
    "required diagnostic",
    () =>
      completedWithProperty("observedNonRequiredEndpoints", [
        RunEvidenceEndpoint.OutpostEthereumDepot
      ])
  ],
  ["empty phase", () => completedWithProperty("phase", "")],
  ["empty endpoint", () => completedWithProperty("endpoint", "")],
  [
    "negative timestamp",
    () => completedWithProperty("observationStartedAtMs", -1)
  ],
  [
    "unsafe timestamp",
    () =>
      completedWithProperty("observationEndedAtMs", Number.MAX_SAFE_INTEGER + 1)
  ],
  [
    "reversed timestamp",
    () => completedWithProperty("observationStartedAtMs", 21n)
  ],
  ["invalid count", () => completedWithProperty("txSuccesses", -1)],
  ["fractional count", () => completedWithProperty("txFailures", 0.5)],
  ["invalid byte size", () => completedWithProperty("envelopeByteSizes", [-1])],
  ["byte count mismatch", () => completedWithProperty("envelopeCount", 2)],
  ["reversed epoch", () => completedWithProperty("epochStart", 2)]
]

/** Exotic callback objects rejected without evaluating accessors. */
export const MaliciousObservationCases: readonly (readonly [
  string,
  () => OppStressRampDeferredCompletedObservation
])[] = [
  [
    "non-enumerable expected field plus stale enumerable field",
    () => {
      const observation = completedObservation()
      Object.defineProperty(observation, "phase", {
        enumerable: false,
        value: observation.phase
      })
      Object.defineProperty(observation, "iterationIndex", {
        enumerable: true,
        value: 0
      })
      return observation
    }
  ],
  [
    "symbol extra field",
    () => {
      const observation = completedObservation()
      Object.defineProperty(observation, Symbol("extra"), {
        enumerable: true,
        value: true
      })
      return observation
    }
  ],
  [
    "custom prototype",
    () => Object.setPrototypeOf(completedObservation(), { inherited: true })
  ]
]

/** Invalid controller clock values rejected independently at either clock read. */
export const InvalidClockValueCases = [
  ["negative", -1],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["fractional", 1.5],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1]
] as const

/** Invalid end-clock values and their expected boundary failure reason. */
export const InvalidEndClockCases = [
  ["negative", -1, "clock endedAtMs must be a non-negative safe integer"],
  ["NaN", Number.NaN, "clock endedAtMs must be a non-negative safe integer"],
  [
    "infinite",
    Number.POSITIVE_INFINITY,
    "clock endedAtMs must be a non-negative safe integer"
  ],
  ["fractional", 1.5, "clock endedAtMs must be a non-negative safe integer"],
  [
    "unsafe",
    Number.MAX_SAFE_INTEGER + 1,
    "clock endedAtMs must be a non-negative safe integer"
  ],
  ["reversed", 9, "controller clock window must be ordered"]
] as const

/** Create a valid completed observation fixture. */
export function completedObservation(): OppStressRampDeferredCompletedObservation {
  return {
    kind: "completed",
    phase: "phase",
    observationStartedAtMs: 10n,
    observationEndedAtMs: 20n,
    txSuccesses: 1,
    txFailures: 0,
    envelopeCount: 1,
    envelopeByteSizes: [128],
    endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
    epochStart: 1,
    epochEnd: 1,
    saturatedEndpoints: [],
    observedNonRequiredEndpoints: []
  }
}

/** Create a valid workload-breakage observation fixture. */
export function breakageObservation(): OppStressRampDeferredBreakageObservation {
  return {
    ...completedObservation(),
    kind: "breakage",
    breakageCategory: RampBreakageCategory.Workload,
    breakageReason: "workload failed"
  }
}

/** Create an isolated evidence directory for one contract case. */
export function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `opp-stress-contract-${label}-`))
}

function completedWithProperty(
  key: string,
  value: unknown
): OppStressRampDeferredCompletedObservation {
  const observation = completedObservation()
  Object.defineProperty(observation, key, { enumerable: true, value })
  return observation
}

function breakageWithProperty(
  key: string,
  value: unknown
): OppStressRampDeferredBreakageObservation {
  const observation = breakageObservation()
  Object.defineProperty(observation, key, { enumerable: true, value })
  return observation
}

function completedWithout(
  key: string
): OppStressRampDeferredCompletedObservation {
  const observation = completedObservation()
  Reflect.deleteProperty(observation, key)
  return observation
}

function breakageWithout(
  key: string
): OppStressRampDeferredBreakageObservation {
  const observation = breakageObservation()
  Reflect.deleteProperty(observation, key)
  return observation
}
