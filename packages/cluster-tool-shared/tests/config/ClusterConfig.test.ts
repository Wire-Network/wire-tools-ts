import {
  ClusterConfigLoggingFileFormat,
  ClusterConfigReportFormat,
  ClusterConfigSchemaCodec,
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"

describe("ClusterConfig shape", () => {
  const config: ClusterConfig = {
    buildPath: "/build",
    clusterPath: "/cluster",
    dataPath: "/cluster/data",
    walletPath: "/cluster/wallet",
    producerCount: 21,
    nodeCount: 1,
    batchOperatorCount: 3,
    underwriterCount: 1,
    epochDurationSec: 60,
    warmupEpochs: 1,
    cooldownEpochs: 1,
    ethereumPath: "/eth",
    solanaPath: "/sol",
    bind: {
      kiod: { address: "127.0.0.1", port: 8900 },
      nodeop: {
        address: "127.0.0.1",
        ports: {
          bios: { http: 8888, p2p: 9876 },
          producers: [{ http: 8988, p2p: 9976 }],
          batch: [],
          underwriters: []
        }
      },
      anvil: { address: "127.0.0.1", port: 8545 },
      solana: {
        address: "127.0.0.1",
        ports: {
          http: 8899,
          faucet: 9900,
          gossip: 8001,
          dynamicRange: { first: 8100, last: 8200 }
        }
      },
      debuggingServer: { address: "127.0.0.1", port: 9901 }
    },
    executables: {
      nodeop: "/build/bin/nodeop",
      kiod: "/build/bin/kiod",
      clio: "/build/bin/clio",
      anvil: "/usr/bin/anvil",
      solanaTestValidator: "/usr/bin/solana-test-validator"
    },
    report: {
      path: "/cluster/reports",
      basename: "cluster-build",
      formats: [
        ClusterConfigReportFormat.csv,
        ClusterConfigReportFormat.md,
        ClusterConfigReportFormat.html
      ]
    },
    logging: {
      levels: { console: Level.info, file: Level.debug },
      fileFormat: ClusterConfigLoggingFileFormat.jsonl
    },
    requiredBatchOperatorCollateral: [
      { chainCode: 1, tokenCode: 2, minimumBond: 1000 }
    ],
    requiredUnderwriterCollateral: [],
    requiredProducerCollateral: [],
    underwriterCollateral: null,
    initialFinalizerKey: null,
    signatureProvider: { type: SignatureProviderType.KEY, ssm: null },
    externalOutposts: null,
    debuggingServerEnabled: true
  }

  it("persists the report/logging enum fields as their wire spellings", () => {
    expect(config.report.formats).toEqual(["csv", "md", "html"])
    expect(config.logging.fileFormat).toBe("jsonl")
    expect(config.logging.levels.console).toBe("info")
  })

  it("survives a JSON round-trip with no data loss", () => {
    const rehydrated = JSON.parse(JSON.stringify(config)) as ClusterConfig
    expect(rehydrated).toEqual(config)
  })

  it("carries per-role collateral requirements as plain (chain, token, bond) triples", () => {
    expect(config.requiredBatchOperatorCollateral).toEqual([
      { chainCode: 1, tokenCode: 2, minimumBond: 1000 }
    ])
  })

  it("round-trips through ClusterConfigSchemaCodec with no data loss", () => {
    const rehydrated = ClusterConfigSchemaCodec.deserialize(
      ClusterConfigSchemaCodec.serialize(config)
    )
    expect(rehydrated).toEqual(config)
  })

  it("loads a legacy config (no signatureProvider/externalOutposts/debuggingServerEnabled) via schema defaults", () => {
    const parsed = JSON.parse(ClusterConfigSchemaCodec.serialize(config))
    delete parsed.signatureProvider
    delete parsed.externalOutposts
    delete parsed.debuggingServerEnabled
    const rehydrated = ClusterConfigSchemaCodec.deserialize(
      JSON.stringify(parsed)
    )
    expect(rehydrated.signatureProvider).toEqual({
      type: SignatureProviderType.KEY,
      ssm: null
    })
    expect(rehydrated.externalOutposts).toBeNull()
    expect(rehydrated.debuggingServerEnabled).toBe(true)
  })
})
