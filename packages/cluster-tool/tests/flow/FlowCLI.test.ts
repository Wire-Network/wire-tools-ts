import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
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

/** The epoch duration the preparing scenario's stage settles on. */
const PreparedEpochDurationSec = 45

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

/** The smallest scenario a `FlowCLI` can run: a name, a context, a plan — and NO prepare stage. */
class FlowTestScenario extends FlowScenario<FlowTestContext> {
  readonly name: string = "flow-cli-test"
  readonly description: string = "a scenario that plans no phases"

  createContext(config: ClusterConfig, log: Logger): FlowTestContext {
    return new FlowTestContext(config, log)
  }

  plan(): void {
    // No phases: the test stops `run` at the composition seam.
  }
}

/**
 * Every options object a `prepare` stage received, across instances —
 * `FlowCLI.create` instantiates the scenario class itself, so the record has
 * to live outside the instance.
 */
const preparedWith: ClusterBuildOptions[] = []

/** A scenario whose pre-bootstrap stage rewrites the options the bootstrap composes with. */
class PreparingScenario extends FlowTestScenario {
  readonly name: string = "flow-cli-prepare-test"

  async prepare(options: ClusterBuildOptions): Promise<ClusterBuildOptions> {
    preparedWith.push(options)
    return { ...options, epochDurationSec: PreparedEpochDurationSec }
  }
}

/** A scenario whose pre-bootstrap stage fails. */
class FailingPrepareScenario extends FlowTestScenario {
  readonly name: string = "flow-cli-failing-prepare-test"

  async prepare(): Promise<ClusterBuildOptions> {
    throw new Error("prepare failed")
  }
}

describe("FlowCLI.run", () => {
  afterEach(() => {
    jest.restoreAllMocks()
    preparedWith.length = 0
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
    // A scenario without a prepare stage composes with the resolved options as they are.
    expect(preparedWith).toEqual([])
  })

  it("awaits the scenario's prepare stage with the RESOLVED options and composes with what it returns", async () => {
    const composed = new Error("composed"),
      compose = jest
        .spyOn(ClusterBuildDefaults, "create")
        .mockRejectedValue(composed)
    await expect(FlowCLI.create(PreparingScenario).run()).rejects.toBe(composed)

    // The stage saw the argv-resolved options…
    expect(preparedWith).toHaveLength(1)
    expect(preparedWith[0].clusterPath).toBe(mockParsedArgv.clusterPath)
    // …and the bootstrap composed with its RETURN value, not the input.
    expect(compose).toHaveBeenCalledTimes(1)
    const [options] = compose.mock.calls[0]
    expect(options.epochDurationSec).toBe(PreparedEpochDurationSec)
    expect(options.clusterPath).toBe(mockParsedArgv.clusterPath)
    expect(preparedWith[0].epochDurationSec).not.toBe(PreparedEpochDurationSec)
  })

  it("a failing prepare stage aborts the run before anything is composed", async () => {
    const compose = jest.spyOn(ClusterBuildDefaults, "create")
    await expect(FlowCLI.create(FailingPrepareScenario).run()).rejects.toThrow(
      "prepare failed"
    )
    expect(compose).not.toHaveBeenCalled()
  })
})
