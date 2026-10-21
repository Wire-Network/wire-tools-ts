import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { FlowCLI, FlowScenario } from "@wireio/cluster-tool/flow"
import { getLogger, type Logger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuildContext,
  ClusterBuildDefaults
} from "@wireio/cluster-tool/orchestration"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

/** The flat record the mocked yargs `parseAsync` yields: the four required roots. */
const mockParsedArgv = {
  clusterPath: "/tmp/flow-cli-test/cluster",
  buildPath: "/tmp/flow-cli-test/build",
  ethereumPath: "/tmp/flow-cli-test/eth",
  solanaPath: "/tmp/flow-cli-test/sol"
}

// `yargs` is ESM-only as of v18 and jest's CJS runtime can't load it (see
// tests/cli/ClusterBuildOptionsArgs.test.ts). `FlowCLI` only chains
// registrations onto the instance and then parses, so a self-returning stand-in
// whose parse yields a hand-built argv exercises `run` end to end.
jest.mock("yargs", () => {
  const argv = {
    option: () => argv,
    scriptName: () => argv,
    usage: () => argv,
    strict: () => argv,
    help: () => argv,
    parseAsync: async () => mockParsedArgv
  }
  return { __esModule: true, default: () => argv }
})

/** A flow's own context subclass. */
class FlowTestContext extends ClusterBuildContext {}

/** The smallest scenario a `FlowCLI` can run: a name, a context, a plan. */
class FlowTestScenario extends FlowScenario<FlowTestContext> {
  readonly name = "flow-cli-test"
  readonly description = "a scenario that plans no phases"

  createContext(config: ClusterConfig, log: Logger): FlowTestContext {
    return new FlowTestContext(config, log)
  }

  plan(): void {
    // No phases: the test stops `run` at the composition seam.
  }
}

describe("FlowCLI.run", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("composes the bootstrap with the scenario's context and never sets a create-only option", async () => {
    // Rejecting stops `run` at the composition seam, before any launch.
    const composed = new Error("composed"),
      compose = jest
        .spyOn(ClusterBuildDefaults, "create")
        .mockRejectedValue(composed)
    await expect(FlowCLI.create(FlowTestScenario).run()).rejects.toBe(composed)

    expect(compose).toHaveBeenCalledTimes(1)
    const [options, createOptions] = compose.mock.calls[0]
    expect(options.clusterPath).toBe(mockParsedArgv.clusterPath)
    // The scenario drives the outpost's launch state and declares its own mock data.
    expect(createOptions).not.toHaveProperty("launchSolanaOutpost")
    expect(createOptions).not.toHaveProperty("enableAutomaticUnderwriting")
    expect(
      createOptions.createContext(fixtureConfig(), getLogger("flow-cli-test"))
    ).toBeInstanceOf(FlowTestContext)
  })
})
