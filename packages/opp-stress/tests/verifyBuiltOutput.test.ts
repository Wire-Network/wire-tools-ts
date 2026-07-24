import { spawnSync } from "node:child_process"
import Path from "node:path"
import { pathToFileURL } from "node:url"

import {
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict
} from "@wireio/test-opp-stress"

const ScriptUrl = pathToFileURL(
    Path.resolve(__dirname, "../scripts/verify-built-output.mjs")
  ).href,
  FixtureFlag = "--fixture=tamper-referenced-artifact",
  ExpectedOrder = [
    "clean:@wireio/debugging-shared",
    "clean:@wireio/debugging-server",
    "clean:@wireio/test-opp-stress",
    "clean:@wireio/test-flow-swap-stress-saturation",
    "build:@wireio/debugging-shared",
    "build:@wireio/debugging-server",
    "build:@wireio/test-opp-stress",
    "build:@wireio/test-flow-swap-stress-saturation",
    "verify:normal"
  ],
  DriverSource = `
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { createBuiltOutputTool } from ${JSON.stringify(ScriptUrl)}

const scenario = process.argv[1]
const fixtureFlag = ${JSON.stringify(FixtureFlag)}
const verdict = ${JSON.stringify({
    invalid: RunEvidenceVerificationVerdict.Invalid,
    inProgress: RunEvidenceVerificationVerdict.InProgress
  })}
const issueCode = ${JSON.stringify({
    hashMismatch: RunEvidenceVerificationIssueCode.HashMismatch
  })}
const packageOutputs = new Map(${JSON.stringify([
    ["@wireio/debugging-shared", ["packages/debugging-shared/lib"]],
    [
      "@wireio/debugging-server",
      ["packages/debugging-server/lib", "packages/debugging-server/dist"]
    ],
    ["@wireio/test-opp-stress", ["packages/opp-stress/lib"]],
    [
      "@wireio/test-flow-swap-stress-saturation",
      ["packages/flow-swap-stress-saturation/lib"]
    ]
  ])})
const allOutputs = [...packageOutputs.values()].flat()
const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "verify-built-tool-driver-"))
const events = []
const stdout = []
const stderr = []
const temporaryRoots = []
let sentinelSeen = false
let outputsAbsent = false
allOutputs.forEach(output => Fs.mkdirSync(Path.join(root, output), { recursive: true }))

const dependencies = {
  root,
  randomUUID: () => "00000000-0000-4000-8000-000000000025",
  runPackageScript: (packageName, script) => {
    events.push(\`\${script}:\${packageName}\`)
    if (scenario === "child-nonzero") return { status: 3, signal: null }
    if (scenario === "child-signal") return { status: null, signal: "SIGTERM" }
    if (events.length === 1) {
      sentinelSeen = Fs.readdirSync(Path.join(root, "packages/opp-stress/lib"))
        .some(file => file.startsWith(".todo25-stale-"))
    }
    const outputs = packageOutputs.get(packageName)
    if (outputs === undefined) throw new Error(\`unexpected package: \${packageName}\`)
    if (script === "clean") {
      outputs.forEach(output => Fs.rmSync(Path.join(root, output), { recursive: true, force: true }))
    } else {
      if (events.length === packageOutputs.size + 1) {
        outputsAbsent = allOutputs.every(output => !Fs.existsSync(Path.join(root, output)))
      }
      outputs.forEach(output => Fs.mkdirSync(Path.join(root, output), { recursive: true }))
    }
    return { status: 0, signal: null }
  },
  verifyFixture: async (temporaryRoot, tamper) => {
    events.push(\`verify:\${tamper ? "tamper" : "normal"}\`)
    temporaryRoots.push(temporaryRoot)
    if (scenario === "verify-failure") throw new Error("injected verification failure")
    return {
      runDirectory: Path.join(temporaryRoot, "run"),
      verdict: tamper ? verdict.invalid : verdict.inProgress,
      valid: !tamper,
      issues: tamper ? [issueCode.hashMismatch] : [],
      strictValid: 1,
      healthyEnvelopeCount: 1,
      tampered: tamper
    }
  },
  writeStdout: text => stdout.push(text),
  writeStderr: text => stderr.push(text)
}

let result = null
let exitCode = null
let error = null
try {
  const tool = createBuiltOutputTool(dependencies)
  if (scenario === "tamper") exitCode = await tool.runCli(["--", fixtureFlag])
  else if (scenario === "help") exitCode = await tool.runCli(["--help"])
  else if (scenario === "unknown") exitCode = await tool.runCli(["--fixture=unknown"])
  else result = await tool.verify(false)
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause)
}
const temporaryRootsAbsent = temporaryRoots.every(path => !Fs.existsSync(path))
Fs.rmSync(root, { recursive: true, force: true })
process.stdout.write(JSON.stringify({
  events,
  stdout,
  stderr,
  result,
  exitCode,
  error,
  sentinelSeen,
  outputsAbsent,
  temporaryRootsAbsent
}))
`

type DriverOutput = {
  readonly events: readonly string[]
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
  readonly result: unknown
  readonly exitCode: number | null
  readonly error: string | null
  readonly sentinelSeen: boolean
  readonly outputsAbsent: boolean
  readonly temporaryRootsAbsent: boolean
}

describe("verify-built-output tooling", () => {
  it("is import-safe and produces no CLI side effects", () => {
    // Given: an import process carrying an argument the CLI would reject.
    const source = `import(${JSON.stringify(ScriptUrl)})`
    // When: the tooling module is imported rather than executed as main.
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", source, "import-probe", "--unknown"],
      { encoding: "utf8" }
    )
    // Then: importing is silent and successful.
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  it("orders stale cleanup, all builds, and direct verification", () => {
    // Given: stale output trees and recording package/runtime collaborators.
    // When: the normal built-output transaction runs.
    const output = runDriver("normal")
    // Then: stale detection, clean/build order, and verification are observable.
    expect(output.sentinelSeen).toBe(true)
    expect(output.outputsAbsent).toBe(true)
    expect(output.events).toEqual(ExpectedOrder)
    expect(output.result).toMatchObject({
      verdict: RunEvidenceVerificationVerdict.InProgress,
      valid: true,
      issues: [],
      strictValid: 1,
      healthyEnvelopeCount: 1,
      sentinelRemoved: true,
      tampered: false
    })
  })

  it("returns nonzero CLI semantics for referenced-artifact tampering", () => {
    // Given: a verifier that reports the expected referenced-artifact defect.
    // When: the documented tamper fixture runs through the CLI boundary.
    const output = runDriver("tamper")
    // Then: output is invalid/hash-mismatched and the outcome is nonzero.
    expect(output.exitCode).toBe(1)
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      verdict: RunEvidenceVerificationVerdict.Invalid,
      valid: false,
      issues: [RunEvidenceVerificationIssueCode.HashMismatch],
      tampered: true
    })
  })

  it.each([
    { scenario: "help", exitCode: 0, channel: "stdout" },
    { scenario: "unknown", exitCode: 2, channel: "stderr" }
  ])("keeps $scenario argument handling side-effect free", row => {
    // Given: collaborators that record every package/runtime action.
    // When: a non-executing CLI branch is selected.
    const output = runDriver(row.scenario)
    // Then: usage is emitted on the correct channel without package work.
    expect(output.exitCode).toBe(row.exitCode)
    expect(output.events).toEqual([])
    expect(row.channel === "stdout" ? output.stdout : output.stderr).toHaveLength(1)
  })

  it.each([
    ["child-nonzero", "@wireio/debugging-shared clean exited 3"],
    ["child-signal", "@wireio/debugging-shared clean was interrupted"]
  ])("fails on %s", (scenario, message) => {
    // Given: the first package command returns an unsuccessful child result.
    // When: the built-output transaction starts.
    const output = runDriver(scenario)
    // Then: it rejects with the exact child invariant.
    expect(output.error).toContain(message)
    expect(output.events).toEqual(["clean:@wireio/debugging-shared"])
  })

  it("removes its temporary root after successful verification", () => {
    // Given/When: a normal verification completes.
    const output = runDriver("normal")
    // Then: its temporary root is absent before the driver cleans its workspace.
    expect(output.temporaryRootsAbsent).toBe(true)
  })

  it("removes its temporary root after verification rejects", () => {
    // Given/When: an injected verification failure propagates.
    const output = runDriver("verify-failure")
    // Then: the exact failure is retained and the temporary root is absent.
    expect(output.error).toBe("injected verification failure")
    expect(output.temporaryRootsAbsent).toBe(true)
  })
})

function runDriver(scenario: string): DriverOutput {
  const execution = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", DriverSource, scenario],
    { encoding: "utf8" }
  )
  if (execution.status !== 0) {
    throw new Error(`built-output test driver failed: ${execution.stderr}`)
  }
  const parsed: unknown = JSON.parse(execution.stdout)
  if (!isDriverOutput(parsed)) throw new Error("invalid built-output driver result")
  return parsed
}

function isDriverOutput(value: unknown): value is DriverOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "events" in value &&
    Array.isArray(value.events) &&
    "stdout" in value &&
    Array.isArray(value.stdout) &&
    "stderr" in value &&
    Array.isArray(value.stderr) &&
    "exitCode" in value &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    "error" in value &&
    (typeof value.error === "string" || value.error === null) &&
    "sentinelSeen" in value &&
    typeof value.sentinelSeen === "boolean" &&
    "outputsAbsent" in value &&
    typeof value.outputsAbsent === "boolean" &&
    "temporaryRootsAbsent" in value &&
    typeof value.temporaryRootsAbsent === "boolean" &&
    "result" in value
  )
}
