import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import type { Argv } from "yargs"

import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createConnectedSwapCanaryConfig,
  createSwapCanaryCommand,
  runSwapCanary,
  SwapCanaryCommand
} from "@wireio/cluster-tool/cli/SwapCanaryCommand"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config/ClusterConfigProvider"
import { SwapRouteSelector } from "@wireio/cluster-tool/tools/all/SwapRouteCatalog"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

interface RecordedOption {
  type?: string
  alias?: string
  demandOption?: boolean
  array?: boolean
  default?: unknown
  choices?: readonly unknown[]
}

function recordOptions(): Map<string, RecordedOption> {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      }
    }
  createSwapCanaryCommand().builder(recorder as Argv)
  return options
}

describe("SwapCanaryCommand", () => {
  let clusterPath: string

  beforeEach(() => {
    clusterPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "wire-swap-canary-command-")
    )
    Fs.writeFileSync(
      Path.join(clusterPath, ClusterConfigProvider.ConfigFilename),
      JSON.stringify({
        ...PersistedFixture,
        clusterPath,
        dataPath: Path.join(clusterPath, "data"),
        walletPath: Path.join(clusterPath, "wallet")
      })
    )
  })

  afterEach(() => {
    Fs.rmSync(clusterPath, { recursive: true, force: true })
  })

  it("registers the connected command with the cluster-path and canary flags", () => {
    const command = createSwapCanaryCommand(),
      options = recordOptions()
    expect(command.command).toBe(ClusterCommand["swap-canary"])
    expect(command.describe).toContain("already-running cluster")
    expect(options.get("cluster-path")).toMatchObject({
      type: "string",
      alias: "d",
      demandOption: true
    })
    expect(options.get("routes")).toMatchObject({
      type: "string",
      array: true,
      default: [SwapRouteSelector.canary]
    })
    expect(options.get("routes")?.choices).toEqual(
      Object.values(SwapRouteSelector)
    )
    expect(options.get("wait-for-challenge")).toMatchObject({
      type: "boolean",
      default: false
    })
    expect(options.get("report-path")?.type).toBe("string")
  })

  it("derives an isolated timestamped report config without mutating the saved file", () => {
    const before = Fs.readFileSync(
        Path.join(clusterPath, ClusterConfigProvider.ConfigFilename),
        "utf8"
      ),
      config = createConnectedSwapCanaryConfig({ clusterPath })
    expect(config.clusterPath).toBe(clusterPath)
    expect(config.report.basename).toBe(SwapCanaryCommand.ReportBasename)
    expect(config.report.path).toMatch(
      new RegExp(
        `${SwapCanaryCommand.ReportSubpath.replaceAll(Path.sep, "[\\\\/]")}[\\\\/].+Z$`
      )
    )
    expect(
      Fs.readFileSync(
        Path.join(clusterPath, ClusterConfigProvider.ConfigFilename),
        "utf8"
      )
    ).toBe(before)
  })

  it("honors an explicit report directory", () => {
    const reportPath = Path.join(clusterPath, "custom-report"),
      config = createConnectedSwapCanaryConfig({ clusterPath, reportPath })
    expect(config.report.path).toBe(reportPath)
  })

  it("fails before planning transactions when persisted cluster state is absent", async () => {
    await expect(
      runSwapCanary({
        clusterPath,
        routes: [SwapRouteSelector.canary],
        waitForChallenge: false
      })
    ).rejects.toThrow(/cluster-state\.json.*not found/)
  })
})
