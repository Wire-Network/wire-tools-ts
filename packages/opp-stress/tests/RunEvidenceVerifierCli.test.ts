import { spawnSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationVerdict
} from "@wireio/test-opp-stress"

import { createVerifierFixture } from "./runEvidenceVerifierTestSupport.js"

const PackageRoot = Path.resolve(__dirname, ".."),
  Script = Path.join(PackageRoot, "scripts", "verify-evidence.mjs")

describe("verify-evidence CLI", () => {
  beforeAll(() => {
    const build = spawnSync(
      "pnpm",
      ["exec", "tsc", "-b", "tsconfig.src.json", "--pretty", "false"],
      { cwd: PackageRoot, encoding: "utf8" }
    )
    expect(build.status).toBe(0)
  })

  it("emits JSON only and exits zero for verified saturation", () => {
    // Given: a canonical saturated run and JSON output mode.
    const fixture = createVerifierFixture()
    try {
      // When: the emitted lib/out CLI verifier is invoked.
      const result = runCli(["--run-dir", fixture.runDirectory, "--json"]),
        report: unknown = JSON.parse(result.stdout)

      // Then: stdout is exactly one report and saturation exits zero.
      expect(result.status).toBe(0)
      expect(report).toMatchObject({
        verdict: RunEvidenceVerificationVerdict.Saturated,
        verifiedSaturated: true
      })
      expect(result.stderr).toBe("")
    } finally {
      fixture.cleanup()
    }
  })

  it("accepts one positional absolute run directory", () => {
    // Given: a canonical saturated run addressed by its absolute run directory.
    const fixture = createVerifierFixture()
    try {
      // When: the verifier receives the documented leading positional form.
      const result = runCli([fixture.runDirectory, "--json"])

      // Then: positional and named run-directory forms have the same success semantics.
      expect(result.status).toBe(0)
      const report: unknown = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        verdict: RunEvidenceVerificationVerdict.Saturated,
        verifiedSaturated: true
      })
      expect(result.stderr).toBe("")
    } finally {
      fixture.cleanup()
    }
  })

  it("accepts JSON before either absolute run-directory form", () => {
    // Given: a canonical saturated run and JSON placed before the directory.
    const fixture = createVerifierFixture()
    try {
      // When: both supported run-directory forms are invoked.
      const positional = runCli(["--json", fixture.runDirectory]),
        named = runCli(["--json", "--run-dir", fixture.runDirectory])

      // Then: argument order does not change either supported form.
      expect(positional.status).toBe(0)
      expect(named.status).toBe(0)
      expect(JSON.parse(positional.stdout)).toMatchObject({ valid: true })
      expect(JSON.parse(named.stdout)).toMatchObject({ valid: true })
    } finally {
      fixture.cleanup()
    }
  })

  it("exits one for valid non-success evidence", () => {
    // Given: a verifier-valid exact-max incomplete run.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Incomplete
    })
    try {
      // When: concise text mode is invoked.
      const result = runCli(["--run-dir", fixture.runDirectory])

      // Then: valid non-success is distinct from invalid evidence.
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(RunEvidenceVerificationVerdict.NonSuccess)
    } finally {
      fixture.cleanup()
    }
  })

  it("exits two for invalid evidence and every unsupported argument form", () => {
    // Given: a missing artifact and the complete unsupported argument matrix.
    const fixture = createVerifierFixture()
    try {
      const manifest: unknown = JSON.parse(
          Fs.readFileSync(
            Path.join(fixture.runDirectory, RunEvidencePath.Manifest),
            "utf8"
          )
        ),
        artifactPath = firstArtifactDataPath(manifest)
      Fs.rmSync(Path.join(fixture.runDirectory, artifactPath))

      // When: invalid evidence and invalid CLI arguments are invoked.
      const invalid = runCli(["--run-dir", fixture.runDirectory, "--json"]),
        misuses = [
          [fixture.runDirectory, "--run-dir", fixture.runDirectory],
          [fixture.runDirectory, fixture.runDirectory],
          ["--run-dir", fixture.runDirectory, "--run-dir", fixture.runDirectory],
          ["--run-dir", fixture.runDirectory, fixture.runDirectory],
          ["--run-dir"],
          ["relative/run"],
          ["--run-dir", "relative/run"],
          [fixture.runDirectory, "--json", "--json"],
          ["--", fixture.runDirectory],
          ["--unknown", fixture.runDirectory]
        ].map(runCli)

      // Then: all misuse exits two and leads with the direct positional command.
      expect(invalid.status).toBe(2)
      expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false })
      misuses.forEach(misuse => {
        expect(misuse.status).toBe(2)
        expect(misuse.stderr).toMatch(
          /^Usage: pnpm --filter @wireio\/test-opp-stress exec node scripts\/verify-evidence\.mjs <runDir>/
        )
        expect(misuse.stderr).toContain("Build prerequisite")
      })
    } finally {
      fixture.cleanup()
    }
  })
})

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [Script, ...args], {
    cwd: PackageRoot,
    encoding: "utf8"
  })
}

function firstArtifactDataPath(manifest: unknown): string {
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("manifest")
  const artifacts = Reflect.get(manifest, "artifacts")
  if (!Array.isArray(artifacts)) throw new Error("artifacts")
  const first = artifacts[0],
    refs =
      typeof first === "object" && first !== null
        ? Reflect.get(first, "firstImmutableRefs")
        : null,
    data =
      typeof refs === "object" && refs !== null
        ? Reflect.get(refs, "data")
        : null,
    path =
      typeof data === "object" && data !== null
        ? Reflect.get(data, "path")
        : null
  if (typeof path !== "string") throw new Error("artifact data path")
  return path
}
