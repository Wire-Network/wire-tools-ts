import { Level } from "@wireio/shared"
import { BindConfig, ClusterConfig } from "@wireio/cluster-tool/config"
import { LogFileAppender } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"

const Address = BindConfig.LoopbackAddress
// Producer / batch / underwriter ports are auto-assigned in production; for this
// fixture derive a deterministic block from named defaults so no port is a bare
// magic literal.
const httpBase = BindConfig.DefaultBiosHttp + 100
const p2pBase = BindConfig.DefaultBiosP2p + 100
const pair = (offset: number) => ({
  http: httpBase + offset,
  p2p: p2pBase + offset
})

/** A complete persisted `cluster-config.json` payload for tests (no env deps). */
export const PersistedFixture = {
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
    kiod: { address: Address, port: BindConfig.DefaultKiod },
    nodeop: {
      address: Address,
      ports: {
        bios: {
          http: BindConfig.DefaultBiosHttp,
          p2p: BindConfig.DefaultBiosP2p
        },
        producers: [pair(0)],
        batch: [pair(1), pair(2), pair(3)],
        underwriters: [pair(4)]
      }
    },
    anvil: { address: Address, port: BindConfig.DefaultAnvil },
    solana: {
      address: Address,
      ports: {
        http: BindConfig.DefaultSolanaRpc,
        faucet: BindConfig.DefaultSolanaFaucet,
        dynamicRange: {
          first: BindConfig.DefaultSolanaDynamicPortFirst,
          last:
            BindConfig.DefaultSolanaDynamicPortFirst +
            BindConfig.SolanaDynamicPortRangeSize -
            1
        }
      }
    },
    debuggingServer: { address: Address, port: BindConfig.DefaultDebuggingServer }
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
    formats: [Report.Format.csv, Report.Format.md, Report.Format.html]
  },
  logging: {
    levels: { console: Level.info, file: Level.debug },
    fileFormat: LogFileAppender.Format.jsonl
  },
  requiredBatchOperatorCollateral: [],
  requiredUnderwriterCollateral: [],
  requiredProducerCollateral: [],
  underwriterCollateral: null,
  initialFinalizerKey: null
}

/** Build a `ClusterConfig` from the fixture (via deserialize — no resolve / env). */
export function fixtureConfig(): ClusterConfig {
  return ClusterConfig.deserialize(JSON.stringify(PersistedFixture))
}
