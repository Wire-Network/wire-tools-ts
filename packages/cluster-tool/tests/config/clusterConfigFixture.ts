import {
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { LogFileAppender } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { Localhost } from "@wireio/cluster-tool/utils"

const Address = Localhost
// Producer / batch / underwriter ports are auto-assigned in production; for this
// fixture derive a deterministic block from named defaults so no port is a bare
// magic literal.
const httpBase = BindConfigProvider.DefaultBiosHttp + 100
const p2pBase = BindConfigProvider.DefaultBiosP2p + 100
const pair = (offset: number) => ({
  http: httpBase + offset,
  p2p: p2pBase + offset
})

/** A complete persisted `cluster-config.json` payload for tests (no env deps).
 *  Typed against the REAL persisted shape so override sites typecheck against
 *  the interface's field types rather than this literal's narrowings. */
export const PersistedFixture: ClusterConfig = {
  buildPath: "/build",
  clusterPath: "/cluster",
  dataPath: "/cluster/data",
  walletPath: "/cluster/wallet",
  producerCount: 21,
  nodeCount: 1,
  batchOperatorCount: 3,
  underwriterCount: 1,
  epochDurationSec: 60,
  operatorsPerEpoch: null,
  batchOpGroups: null,
  epochRetentionEnvelopeLogCount: null,
  warmupEpochs: 1,
  cooldownEpochs: 1,
  terminateMaxConsecutiveMisses: null,
  terminateMaxPercentMisses24h: null,
  terminateWindowMs: null,
  ethereumPath: "/eth",
  solanaPath: "/sol",
  bind: {
    kiod: { address: Address, port: BindConfigProvider.DefaultKiod },
    nodeop: {
      address: Address,
      ports: {
        bios: {
          http: BindConfigProvider.DefaultBiosHttp,
          p2p: BindConfigProvider.DefaultBiosP2p
        },
        producers: [pair(0)],
        batch: [pair(1), pair(2), pair(3)],
        underwriters: [pair(4)]
      }
    },
    anvil: { address: Address, port: BindConfigProvider.DefaultAnvil },
    solana: {
      address: Address,
      ports: {
        http: BindConfigProvider.DefaultSolanaRpc,
        faucet: BindConfigProvider.DefaultSolanaFaucet,
        gossip: BindConfigProvider.DefaultSolanaGossip,
        dynamicRange: {
          first: BindConfigProvider.DefaultSolanaDynamicPortFirst,
          last:
            BindConfigProvider.DefaultSolanaDynamicPortFirst +
            BindConfigProvider.SolanaDynamicPortRangeSize -
            1
        }
      }
    },
    debuggingServer: {
      address: Address,
      port: BindConfigProvider.DefaultDebuggingServer
    }
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
  initialFinalizerKey: null,
  signatureProvider: { type: SignatureProviderType.KEY, ssm: null },
  externalOutposts: null,
  debuggingServerEnabled: true,
  enableMockReserves: false
}

/** Build a `ClusterConfig` from the fixture (via deserialize — no resolve / env).
 *
 * @param overrides - Top-level fixture fields to replace (typed by the fixture
 *   itself). Nested structures are replaced whole — spread the fixture's own
 *   nested object at the call site to change one leaf
 *   (`executables: { ...PersistedFixture.executables, nodeop: "/bin/true" }`).
 */
export function fixtureConfig(
  overrides: Partial<ClusterConfig> = {}
): ClusterConfig {
  return ClusterConfigProvider.deserialize(
    JSON.stringify({ ...PersistedFixture, ...overrides })
  )
}
