import type { ArgumentsCamelCase, Argv } from "yargs"

import { ClusterManager } from "@wireio/cluster-tool/cluster/ClusterManager"
import { FlowCLI, FlowScenario } from "@wireio/cluster-tool/flow"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration/ClusterBuildDefaults"
import type { ClusterBuild } from "@wireio/cluster-tool/orchestration/ClusterBuild"
import type { ClusterBuildContext } from "@wireio/cluster-tool/orchestration/ClusterBuildContext"
import type { Report } from "@wireio/cluster-tool/report"

interface TestArguments {
  readonly routes: readonly string[]
  readonly waitForChallenge: boolean
}

interface FlowCLIWithScenario {
  readonly scenario: ArgumentScenario
}

const RequiredArguments = [
  "--cluster-path",
  "/tmp/flow-cli-test",
  "--build-path",
  "/tmp/wire-build",
  "--ethereum-path",
  "/tmp/wire-ethereum",
  "--solana-path",
  "/tmp/wire-solana"
]

class ArgumentScenario extends FlowScenario<
  ClusterBuildContext,
  TestArguments
> {
  readonly name = "flow-argument-test"
  readonly description = "typed scenario argument test"
  received: TestArguments

  override configureArguments(yargs: Argv): Argv {
    return yargs
      .option("routes", { type: "string", array: true, default: ["canary"] })
      .option("wait-for-challenge", { type: "boolean", default: false })
  }

  override parseArguments(argv: ArgumentsCamelCase): TestArguments {
    return {
      routes: argv.routes as string[],
      waitForChallenge: Boolean(argv.waitForChallenge)
    }
  }

  plan(_cluster: ClusterBuild, args: TestArguments): void {
    this.received = args
  }
}

describe("FlowCLI scenario arguments", () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
    jest.restoreAllMocks()
  })

  it("parses scenario-only options and passes typed values to plan", async () => {
    process.argv = [
      "node",
      "flow-argument-test",
      ...RequiredArguments,
      "--routes",
      "eth-to-sol",
      "--routes",
      "wire-to-sol",
      "--wait-for-challenge"
    ]
    const cluster = { report: { name: "", succeeded: true } } as ClusterBuild
    jest.spyOn(ClusterBuildDefaults, "create").mockResolvedValue(cluster)
    jest
      .spyOn(ClusterManager, "launch")
      .mockResolvedValue(cluster.report as Report)

    const cli = FlowCLI.create(ArgumentScenario)
    await cli.run()

    expect((cli as unknown as FlowCLIWithScenario).scenario.received).toEqual({
      routes: ["eth-to-sol", "wire-to-sol"],
      waitForChallenge: true
    })
  })

  it("uses scenario defaults when no scenario-only flags are supplied", async () => {
    process.argv = ["node", "flow-argument-test", ...RequiredArguments]
    const cluster = { report: { name: "", succeeded: true } } as ClusterBuild
    jest.spyOn(ClusterBuildDefaults, "create").mockResolvedValue(cluster)
    jest
      .spyOn(ClusterManager, "launch")
      .mockResolvedValue(cluster.report as Report)

    const cli = FlowCLI.create(ArgumentScenario)
    await cli.run()

    expect((cli as unknown as FlowCLIWithScenario).scenario.received).toEqual({
      routes: ["canary"],
      waitForChallenge: false
    })
  })
})
