import type {
  ClusterConfigLogging,
  CollateralRequirement
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import type {
  ClusterBuildOptions,
  LoggingOptions
} from "@wireio/cluster-tool/config"
import { LogFileAppender } from "@wireio/cluster-tool/logging"

describe("ClusterBuildOptions types", () => {
  it("accepts a fully-populated options object", () => {
    const options: ClusterBuildOptions = {
      buildPath: "/build",
      clusterPath: "/cluster",
      ethereumPath: "/eth",
      solanaPath: "/sol",
      producerCount: 1,
      batchOperatorCount: 3,
      underwriterCount: 1,
      epochDurationSec: 60,
      bindAll: false,
      bind: { anvil: { port: 8545 } },
      report: { formats: [] },
      logging: { levels: { console: Level.info } }
    }
    expect(options.epochDurationSec).toBe(60)
    expect(options.bind?.anvil?.port).toBe(8545)
  })

  it("models the resolved ClusterConfigLogging and caller LoggingOptions distinctly", () => {
    const config: ClusterConfigLogging = {
      levels: { console: Level.info, file: Level.debug },
      fileFormat: LogFileAppender.Format.jsonl
    }
    const options: LoggingOptions = { levels: { console: Level.warn } }
    expect(config.levels.file).toBe(Level.debug)
    expect(options.levels?.console).toBe(Level.warn)
  })

  it("models a per-(chain,token) collateral requirement", () => {
    const req: CollateralRequirement = {
      chainCode: 2,
      tokenCode: 1,
      minimumBond: 1_000
    }
    expect(req.minimumBond).toBe(1_000)
  })
})
