import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import ts from "typescript"

const RepoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const ProbeTimeoutMs = 3_000
const Flows = [
  "flow-ethereum-round-trip",
  "flow-lco-launch-smoke",
  "flow-batch-relay-restart",
  "flow-batch-roster-replacement"
]

// The real executable must terminate after its report, even when a client or
// logger leaves a handle alive. No chain, account, socket or daemon is started.
const Probe = `
const Module = require("node:module")
const succeeded = process.argv[2] === "1"
const Scenario = class {}
Module._load = request => {
  if (request === "@wireio/cluster-tool") return {FlowCLI: {create: () => ({run: async () => {
    setInterval(() => {}, 60000)
    return {succeeded}
  }})}}
  if (request.endsWith("Scenario.js")) return {
    EthereumHappyScenario: Scenario, LcoLaunchSmokeScenario: Scenario,
    BatchRelayRestartScenario: Scenario, BatchRosterReplacementScenario: Scenario
  }
  throw new Error("Unexpected executable dependency: " + request)
}
new Module("flow-entrypoint-probe")._compile(process.argv[1], "flow-entrypoint.js")
`

for (const flow of Flows) {
  for (const succeeded of [true, false]) {
    test(`${flow} exits ${succeeded ? 0 : 1} from the report despite an open handle`, () => {
      const source = fs.readFileSync(path.join(RepoPath, "packages", flow, "src/index.ts"), "utf8")
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText
      const result = spawnSync(process.execPath, ["-e", Probe, compiled, succeeded ? "1" : "0"], {
        encoding: "utf8",
        timeout: ProbeTimeoutMs
      })
      assert.equal(result.error, undefined, result.stderr)
      assert.equal(result.signal, null, result.stderr)
      assert.equal(result.status, succeeded ? 0 : 1, result.stderr)
    })
  }
}
