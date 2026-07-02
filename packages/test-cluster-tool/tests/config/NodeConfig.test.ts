import {
  BindConfig,
  NodeConfig,
  NodeConfigIniRenderer,
  NodeRole,
  producerName
} from "@wireio/test-cluster-tool/config"
import { WireClient } from "@wireio/test-cluster-tool/clients/wire"
import { fixtureConfig } from "./clusterConfigFixture.js"

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

  describe("plan", () => {
    const nodes = NodeConfig.plan(fixtureConfig())

    it("plans bios + producer + operator nodes from the bind topology", () => {
      expect(nodes).toHaveLength(6) // 1 bios + 1 producer + 3 batch + 1 underwriter
      expect(nodes[0].role).toBe(NodeRole.bios)
      expect(nodes[0].name).toBe(NodeConfig.BiosName)
      const operators = nodes.filter(n => n.role === NodeRole.operator)
      expect(operators).toHaveLength(4)
      expect(operators.filter(n => n.batchOperatorAccount !== null)).toHaveLength(3)
      expect(operators.filter(n => n.underwriterAccount !== null)).toHaveLength(1)
    })

    it("gives each node peer endpoints to every other node", () => {
      nodes.forEach(n => expect(n.peerEndpoints).toHaveLength(nodes.length - 1))
    })

    it("distributes the defproducer names onto the producer node", () => {
      const producer = nodes.find(n => n.role === NodeRole.producer)
      expect(producer?.producers).toHaveLength(21)
      expect(producer?.producers[0]).toBe("defproducera")
    })

    it("names operator accounts from the Constants generators", () => {
      const batchOps = nodes
        .filter(n => n.batchOperatorAccount !== null)
        .map(n => n.batchOperatorAccount)
      expect(batchOps).toContain("batchop.a")
      expect(nodes.find(n => n.underwriterAccount !== null)?.underwriterAccount).toBe(
        "uwrit.a"
      )
    })
  })

  describe("ini renderer", () => {
    const nodes = NodeConfig.plan(fixtureConfig())

    it("renders bios config with stale-production + signature-provider", () => {
      const bios = nodes.find(n => n.role === NodeRole.bios)!
      const ini = bios.ini.render()
      expect(ini).toContain("enable-stale-production = true")
      expect(ini).toContain("signature-provider")
      expect(ini).toContain(
        `p2p-listen-endpoint = ${BindConfig.LoopbackAddress}:${BindConfig.DefaultBiosP2p}`
      )
      expect(ini).toContain("http-validate-host = false")
    })

    it("renders operator config with read-mode + the operator account", () => {
      const batchOp = nodes.find(n => n.batchOperatorAccount !== null)!
      const ini = batchOp.ini.render()
      expect(ini).toContain(`read-mode = ${WireClient.FinalityType.irreversible}`)
      expect(ini).toContain(
        `batch-operator-account = ${batchOp.batchOperatorAccount}`
      )
    })

    it("lists every peer's p2p endpoint", () => {
      const producer = nodes.find(n => n.role === NodeRole.producer)!
      const ini = producer.ini.render()
      expect(ini).toContain(
        `p2p-peer-address = ${NodeConfigIniRenderer.Loopback}:${BindConfig.DefaultBiosP2p}`
      )
    })
  })

  describe("logging renderer", () => {
    it("renders valid logging.json with both sinks and the loggers", () => {
      const node = NodeConfig.plan(fixtureConfig())[0]
      const parsed = JSON.parse(node.logging.render())
      expect(parsed.sinks).toHaveLength(2)
      expect(
        parsed.loggers.some(
          (logger: { name: string }) => logger.name === "producer_plugin"
        )
      ).toBe(true)
    })
  })

  describe("genesis renderer (via ClusterConfig.genesis)", () => {
    it("renders valid genesis.json with the dev initial_key + CPU overrides", () => {
      const genesis = JSON.parse(fixtureConfig().genesis.render())
      expect(genesis.initial_key).toMatch(/^SYS/)
      expect(genesis.initial_configuration.max_block_cpu_usage).toBe(400_000)
    })

    it("omits initial_finalizer_key when none is set", () => {
      const genesis = JSON.parse(fixtureConfig().genesis.render())
      expect(genesis.initial_finalizer_key).toBeUndefined()
    })
  })
})
