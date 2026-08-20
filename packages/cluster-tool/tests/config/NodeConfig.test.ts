import { AWSAccountName, SignatureProviderType } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool"
import { Level } from "@wireio/shared"
import {
  NodeConfig,
  NodeConfigIniRenderer,
  NodeConfigLoggingRenderer,
  NodeRole,
  producerName,
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Localhost } from "@wireio/cluster-tool/utils"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

/** One `loggers[]` entry of a rendered nodeop `logging.json`. */
interface RenderedLogger {
  /** The nodeop logger's name (`producer_plugin`, …). */
  name: string
  /** The `fc::log_level` spelling nodeop filters this logger at. */
  level: string
}

describe("NodeConfig", () => {
  describe("producerName", () => {
    it("names the first 26 producers defproducera..z", () => {
      expect(producerName(0)).toBe("defproducera")
      expect(producerName(25)).toBe("defproducerz")
    })
    it("rolls over past 26 with the defpr prefix", () => {
      expect(producerName(26)).toMatch(/^defpr/)
    })
  })

  describe("peerCapacity", () => {
    it("sums the whole planned topology plus bios and ad-hoc headroom", () => {
      const capacity = NodeConfig.peerCapacity(
        fixtureConfig({
          nodeCount: 21,
          batchOperatorCount: 21,
          underwriterCount: 1
        })
      )
      expect(capacity).toBe(21 + 21 + 1 + NodeConfig.BiosNodeCount + NodeConfig.AdHocDaemonPeerHeadroom)
    })

    it("covers the full mesh every node is wired into", () => {
      // Each node dials every OTHER node, so the capacity must be at least the
      // peer count — a cap below it makes nodes refuse the surplus inbound
      // dials, which freezes LIB (the 2026-08-04 21-producer create).
      const config = fixtureConfig({
        nodeCount: 21,
        batchOperatorCount: 21,
        underwriterCount: 1
      })
      const totalNodes =
        config.nodeCount + config.batchOperatorCount + config.underwriterCount + NodeConfig.BiosNodeCount
      expect(NodeConfig.peerCapacity(config)).toBeGreaterThanOrEqual(totalNodes - 1)
    })

    it("scales down to the single-producer dev topology", () => {
      expect(
        NodeConfig.peerCapacity(
          fixtureConfig({
            nodeCount: 1,
            batchOperatorCount: 3,
            underwriterCount: 1
          })
        )
      ).toBe(1 + 3 + 1 + NodeConfig.BiosNodeCount + NodeConfig.AdHocDaemonPeerHeadroom)
    })
  })

  describe("plan", () => {
    const nodes = NodeConfig.plan(fixtureConfig())

    it("plans bios + producer + operator nodes from the bind topology", () => {
      expect(nodes).toHaveLength(6) // 1 bios + 1 producer + 3 batch + 1 underwriter
      expect(nodes[0].role).toBe(NodeRole.bios)
      expect(nodes[0].name).toBe(NodeConfig.BiosName)
      const operators = nodes.filter(n => n.role === NodeRole.operator)
      expect(operators).toHaveLength(4)
      expect(operators.filter(n => n.batchOperatorLabel !== null)).toHaveLength(3)
      expect(operators.filter(n => n.underwriterLabel !== null)).toHaveLength(1)
    })

    it("meshes ONLY the producing set — bios + producers peer with each other", () => {
      const mesh = nodes.filter(n => n.role !== NodeRole.operator)
      mesh.forEach(n => expect(n.peerEndpoints).toHaveLength(mesh.length - 1))
    })

    it("attaches each operator to exactly ONE producer, not the mesh", () => {
      // Operators produce nothing; meshing them makes p2p flooding O(N^2) in a
      // set that only needs a view of the chain. A full mesh at 21 producers /
      // 22 operators drove block relay to 28-45s on loopback and froze LIB.
      const producer = nodes.find(n => n.role === NodeRole.producer)!,
        producerEndpoint = `${producer.advertiseAddress}:${producer.ports.p2p}`
      nodes
        .filter(n => n.role === NodeRole.operator)
        .forEach(operator => {
          expect(operator.peerEndpoints).toHaveLength(1)
          expect(operator.peerEndpoints[0]).toBe(producerEndpoint)
        })
    })

    it("keeps operators OUT of every mesh member's peer list", () => {
      const operatorEndpoints = nodes
        .filter(n => n.role === NodeRole.operator)
        .map(n => `${n.advertiseAddress}:${n.ports.p2p}`)
      nodes
        .filter(n => n.role !== NodeRole.operator)
        .forEach(meshNode =>
          operatorEndpoints.forEach(endpoint => expect(meshNode.peerEndpoints).not.toContain(endpoint))
        )
    })

    it("distributes the defproducer names onto the producer node", () => {
      const producer = nodes.find(n => n.role === NodeRole.producer)
      expect(producer?.producers).toHaveLength(21)
      expect(producer?.producers[0]).toBe("defproducera")
    })

    it("names operator labels from the Constants generators", () => {
      const batchOps = nodes.filter(n => n.batchOperatorLabel !== null).map(n => n.batchOperatorLabel)
      expect(batchOps).toContain("batchop.a")
      expect(nodes.find(n => n.underwriterLabel !== null)?.underwriterLabel).toBe("uwrit.a")
    })
  })

  describe("multi-host advertise addresses", () => {
    const ProducerAdvertiseAddress = "10.0.0.11"
    const meshed = fixtureConfig({
      bind: {
        ...PersistedFixture.bind,
        nodeop: {
          ...PersistedFixture.bind.nodeop,
          ports: {
            ...PersistedFixture.bind.nodeop.ports,
            producers: [
              {
                ...PersistedFixture.bind.nodeop.ports.producers[0],
                advertiseAddress: ProducerAdvertiseAddress
              }
            ]
          }
        }
      }
    })
    const nodes = NodeConfig.plan(meshed)

    it("advertiseAddressFor prefers the per-node address, else the dialable bind address", () => {
      expect(NodeConfig.advertiseAddressFor(meshed, meshed.bind.nodeop.ports.producers[0])).toBe(
        ProducerAdvertiseAddress
      )
      expect(NodeConfig.advertiseAddressFor(meshed, meshed.bind.nodeop.ports.bios)).toBe(Localhost)
    })

    it("each node advertises its own address", () => {
      expect(nodes.find(n => n.role === NodeRole.producer)?.advertiseAddress).toBe(ProducerAdvertiseAddress)
      expect(nodes[0].advertiseAddress).toBe(Localhost)
    })

    it("peers dial the producer at its advertised address; every other peer stays on the shared address", () => {
      const producerP2p = meshed.bind.nodeop.ports.producers[0].p2p,
        bios = nodes[0]
      expect(bios.peerEndpoints).toContain(`${ProducerAdvertiseAddress}:${producerP2p}`)
      bios.peerEndpoints
        .filter(endpoint => !endpoint.startsWith(ProducerAdvertiseAddress))
        .forEach(endpoint => expect(endpoint.startsWith(`${Localhost}:`)).toBe(true))
    })

    it("renders the advertised p2p-server-address into the node ini", () => {
      const producer = nodes.find(n => n.role === NodeRole.producer)!
      expect(producer.ini.render()).toContain(`p2p-server-address = ${ProducerAdvertiseAddress}:${producer.ports.p2p}`)
    })
  })

  describe("ini renderer", () => {
    const nodes = NodeConfig.plan(fixtureConfig())

    it("renders bios config with stale-production + signature-provider", () => {
      const bios = nodes.find(n => n.role === NodeRole.bios)!
      const ini = bios.ini.render()
      expect(ini).toContain("enable-stale-production = true")
      expect(ini).toContain("signature-provider")
      expect(ini).toContain(`p2p-listen-endpoint = ${Localhost}:${BindConfigProvider.DefaultBiosP2p}`)
      expect(ini).toContain("http-validate-host = false")
      // Dev boxes routinely sit above nodeop's 90% resource-monitor disk
      // threshold; without this line every node self-terminates ~1s after
      // boot and the only harness symptom is a readiness-probe timeout.
      expect(ini).toContain("resource-monitor-not-shutdown-on-threshold-exceeded = true")
    })

    it("renders the bios signature-provider byte-identically to the historical dev spec under KEY", () => {
      const bios = nodes.find(n => n.role === NodeRole.bios)!
      expect(bios.ini.render()).toContain(`signature-provider = ${Constants.devSignatureProvider()}`)
    })

    it("renders the bios signature-provider as a REGION-LESS SSM spec under SSM", () => {
      const ssmCluster = fixtureConfig({
          initialKey: "PUB_K1_generatedBiosBlockSigningKey",
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: ["us-east-1"],
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
            }
          },
          awsClusterNodeConfig: {
            account: AWSAccountName.dev,
            regions: ["us-east-1"],
            ssm: null
          }
        }),
        bios = NodeConfig.plan(ssmCluster).find(n => n.role === NodeRole.bios)!
      // `{account}` is the NODE NAME — the same segment NodeopProcess.buildArgs renders.
      expect(bios.ini.render()).toContain(
        `signature-provider = wire-PUB_K1_generatedBiosBlockSigningKey,wire,wire,PUB_K1_generatedBiosBlockSigningKey,SSM:/wire/${AWSAccountName.dev}/${NodeConfig.BiosName}/K1`
      )
    })

    it("renders operator config with read-mode and WITHOUT an account line (daemon CLI args carry the generated account)", () => {
      const batchOp = nodes.find(n => n.batchOperatorLabel !== null)!
      const ini = batchOp.ini.render()
      expect(ini).toContain(`read-mode = ${WireClient.FinalityType.irreversible}`)
      expect(ini).not.toContain("batch-operator-account")
      expect(ini).not.toContain("underwriter-account")
    })

    it("lists every peer's p2p endpoint", () => {
      const producer = nodes.find(n => n.role === NodeRole.producer)!
      const ini = producer.ini.render()
      expect(ini).toContain(`p2p-peer-address = ${NodeConfigIniRenderer.Loopback}:${BindConfigProvider.DefaultBiosP2p}`)
    })
  })

  describe("logging renderer", () => {
    it("renders valid logging.json with both sinks and the loggers", () => {
      const node = NodeConfig.plan(fixtureConfig())[0]
      const parsed = JSON.parse(node.logging.render())
      expect(parsed.sinks).toHaveLength(2)
      expect(parsed.loggers.some((logger: RenderedLogger) => logger.name === "producer_plugin")).toBe(true)
    })

    it("takes every logger's level from logging.levels.console", () => {
      const node = NodeConfig.plan(
        fixtureConfig({
          logging: {
            ...PersistedFixture.logging,
            levels: { console: Level.warn, file: Level.debug }
          }
        })
      )[0]
      const { loggers } = JSON.parse(node.logging.render())
      expect(loggers.length).toBeGreaterThan(0)
      loggers.forEach((logger: RenderedLogger) =>
        expect(logger.level).toBe(NodeConfigLoggingRenderer.NodeopLogLevel.warn)
      )
    })

    // The regression pin for the 2026-08-04 log flood: `net_plugin_impl` at
    // `debug` on a 43-identity mesh logs every block send/receive/vote/nack
    // from every node. It was HARDCODED to debug regardless of config, which
    // exhausted the runner's socket buffers (run 3, `write ENOBUFS`) and then
    // OOM'd the harness at a 4GB V8 heap in StreamBase::Writev (run 6).
    it("does NOT pin net_plugin_impl to debug when the cluster asks for info", () => {
      const node = NodeConfig.plan(
        fixtureConfig({
          logging: {
            ...PersistedFixture.logging,
            levels: { console: Level.info, file: Level.debug }
          }
        })
      )[0]
      const { loggers } = JSON.parse(node.logging.render()),
        netPlugin = loggers.find((logger: RenderedLogger) => logger.name === "net_plugin_impl")
      expect(netPlugin).toBeDefined()
      expect(netPlugin.level).toBe(NodeConfigLoggingRenderer.NodeopLogLevel.info)
    })
  })

  describe("NodeConfigLoggingRenderer.toNodeopLevel", () => {
    // fc declares neither `trace` nor `fatal`; from_variant(log_level&) THROWS
    // on an unrecognized spelling, so a raw hand-off kills the node at startup.
    it("maps the two levels fc does not declare onto ones it does", () => {
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.trace)).toBe(NodeConfigLoggingRenderer.NodeopLogLevel.all)
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.fatal)).toBe(NodeConfigLoggingRenderer.NodeopLogLevel.error)
    })

    it("passes through the four levels both enums share", () => {
      const { NodeopLogLevel } = NodeConfigLoggingRenderer
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.debug)).toBe(NodeopLogLevel.debug)
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.info)).toBe(NodeopLogLevel.info)
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.warn)).toBe(NodeopLogLevel.warn)
      expect(NodeConfigLoggingRenderer.toNodeopLevel(Level.error)).toBe(NodeopLogLevel.error)
    })

    it("only ever yields a spelling fc::log_level declares", () => {
      const declared = Object.values(NodeConfigLoggingRenderer.NodeopLogLevel) as string[]
      Object.values(Level).forEach(level => expect(declared).toContain(NodeConfigLoggingRenderer.toNodeopLevel(level)))
    })
  })

  describe("genesis renderer (via ClusterConfigProvider.genesis)", () => {
    it("renders valid genesis.json with the dev initial_key + CPU overrides", () => {
      const genesis = JSON.parse(ClusterConfigProvider.genesisRenderer(fixtureConfig()).render())
      expect(genesis.initial_key).toMatch(/^SYS/)
      expect(genesis.initial_configuration.max_block_cpu_usage).toBe(400_000)
    })

    it("takes initial_key + initial_finalizer_key from the CONFIG, not a constant", () => {
      // An SSM cluster's bios keys are GENERATED at config resolution, so the
      // genesis authority — and therefore the chain id — follows the config.
      const genesis = JSON.parse(
        ClusterConfigProvider.genesisRenderer(
          fixtureConfig({
            initialKey: "PUB_K1_generatedBiosBlockSigningKey",
            initialFinalizerKey: "PUB_BLS_generatedBiosFinalizerKey"
          })
        ).render()
      )
      expect(genesis.initial_key).toBe("PUB_K1_generatedBiosBlockSigningKey")
      expect(genesis.initial_finalizer_key).toBe("PUB_BLS_generatedBiosFinalizerKey")
    })

    it("omits initial_finalizer_key when none is set", () => {
      const genesis = JSON.parse(
        ClusterConfigProvider.genesisRenderer(fixtureConfig({ initialFinalizerKey: null })).render()
      )
      expect(genesis.initial_finalizer_key).toBeUndefined()
    })

    it("does not emit the removed base_per_transaction_net_usage parameter", () => {
      const genesis = JSON.parse(ClusterConfigProvider.genesisRenderer(fixtureConfig()).render())
      expect(genesis.initial_configuration.net_usage_leeway).toBe(500)
      expect(genesis.initial_configuration).not.toHaveProperty("base_per_transaction_net_usage")
    })
  })
})
