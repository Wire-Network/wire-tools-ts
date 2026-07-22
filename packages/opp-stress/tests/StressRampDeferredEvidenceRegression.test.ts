import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { spawnSync } from "node:child_process"

import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  OppStressRampEvidenceModeKind,
  OppStressRampTelemetryIntegrityError,
  RampBreakageCategory,
  runOppStressRamp
} from "@wireio/test-opp-stress"
import type { OppStressRampDeferredEvidenceIterationObservation } from "@wireio/test-opp-stress"

import {
  RampConfig,
  RequiredEndpoints
} from "./stressRampContractTestSupport.js"
import {
  parseTestEvidence,
  type TestEvidence
} from "./stressRampDeferredEvidenceTestSupport.js"

describe("OPP stress ramp deferred evidence regressions", () => {
  it("classifies branded callback rejection as telemetry integrity", async () => {
    // Given: the generic callback rejects with canonical degraded telemetry.
    const error = new OppStressRampTelemetryIntegrityError(
      "telemetry failed",
      degradedTelemetry()
    )

    // When: the deferred evidence controller settles the callback.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      parseEvidence: parseTestEvidence,
      runIteration: (): Promise<
        OppStressRampDeferredEvidenceIterationObservation<TestEvidence>
      > => Promise.reject(error)
    })

    // Then: the boundary summary retains the canonical category, telemetry, and cause.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.TelemetryIntegrity,
      telemetry: error.telemetry,
      cause: error
    })
  })

  it("rejects a legacy deferred value that owns parseEvidence", () => {
    // Given: an unsuppressed compiler fixture creates the previously ambiguous intersection.
    const fixtureDir = Fs.mkdtempSync(
        Path.join(Os.tmpdir(), "opp-stress-deferred-types-")
      ),
      fixturePath = Path.join(fixtureDir, "legacy-parse-evidence.ts"),
      configPath = Path.join(fixtureDir, "tsconfig.json")
    try {
      Fs.writeFileSync(fixturePath, compilerFixture())
      Fs.writeFileSync(configPath, compilerConfig(fixturePath))

      // When: TypeScript checks the ambiguous value against the public overloads.
      const compilation = spawnSync(
        "pnpm",
        ["exec", "tsc", "--pretty", "false", "--project", configPath],
        { encoding: "utf8" }
      )

      // Then: legacy ownership of parseEvidence is statically impossible.
      expect(compilation.status).not.toBe(0)
      expect(`${compilation.stdout}${compilation.stderr}`).toContain(
        "parseEvidence"
      )
    } finally {
      Fs.rmSync(fixtureDir, { recursive: true, force: true })
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

function compilerFixture(): string {
  return `import {
  OppStressRampEvidenceModeKind,
  type OppStressRampDeferredOptions
} from "@wireio/test-opp-stress/ramp-controller-types"

declare const runIteration: OppStressRampDeferredOptions["runIteration"]
const parser = { parseEvidence: () => ({}) }
const ambiguous: OppStressRampDeferredOptions & typeof parser = {
  evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
  requiredEndpoints: [],
  runIteration,
  ...parser
}
void ambiguous
`
}

function compilerConfig(fixturePath: string): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strictNullChecks: false,
      noImplicitAny: false,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [Path.resolve(__dirname, "../../../node_modules/@types")],
      ignoreDeprecations: "6.0",
      baseUrl: Path.resolve(__dirname, ".."),
      paths: {
        "@wireio/test-opp-stress/ramp-controller-types": [
          "src/rampControllerTypes.ts"
        ],
        "@wireio/debugging-shared": ["../debugging-shared/src"]
      }
    },
    files: [fixturePath]
  })
}
