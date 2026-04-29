import "jest"
import { generateGenesis } from "@wireio/test-cluster-tool/cluster/genesis"
import { generateLoggingConfig } from "../../src/cluster/generateLoggingConfig"
import { buildStartCmd } from "@wireio/test-cluster-tool/cluster/startCmd"
import {
  BIOS_K1_KEY,
  BIOS_BLS_KEY,
  formatK1SignatureProvider,
  formatBLSSignatureProvider
} from "@wireio/test-cluster-tool/cluster/keyGen"
import {
  DEV_K1_PUBLIC_KEY,
  DEV_K1_PRIVATE_KEY,
  BIOS_P2P_PORT,
  BIOS_HTTP_PORT
} from "@wireio/test-cluster-tool/cluster/constants"
import OS from "node:os"
import { ClusterManager } from "@wireio/test-cluster-tool"

describe("ClusterManager smoke tests", () => {
  describe("genesis.ts", () => {
    test("generates valid genesis with initial_key and initial_configuration", () => {
      const genesis = generateGenesis()
      expect(genesis.initial_key).toBe(DEV_K1_PUBLIC_KEY)
      expect(genesis.initial_timestamp).toBeDefined()
      expect(genesis.initial_configuration.max_block_cpu_usage).toBe(400000)
      expect(genesis.initial_configuration.max_transaction_cpu_usage).toBe(
        375000
      )
    })

    test("includes initial_finalizer_key when provided", () => {
      const genesis = generateGenesis({
        initialFinalizerKey: BIOS_BLS_KEY.publicKey
      })
      expect(genesis.initial_finalizer_key).toBe(BIOS_BLS_KEY.publicKey)
    })
  })

  describe("generateLoggingConfig.ts", () => {
    test("generates JSON with stderr_color sink and standard loggers", () => {
      const config = generateLoggingConfig(OS.tmpdir()) as {
        sinks: Array<{ name: string }>
        loggers: Array<{ name: string }>
      }
      expect(config.sinks[0].name).toBe("stderr_color")
      expect(config.loggers.length).toBeGreaterThan(5)
      const names = config.loggers.map(l => l.name)
      expect(names).toContain("default")
      expect(names).toContain("producer_plugin")
      expect(names).toContain("net_plugin_impl")
      expect(names).toContain("vote")
    })
  })

  describe("startCmd.ts", () => {
    test("builds bios start.cmd with both K1 and BLS signature-providers", () => {
      const cmd = buildStartCmd({
        nodeopBinary: "/opt/bin/nodeop",
        p2pListenEndpoint: `0.0.0.0:${BIOS_P2P_PORT}`,
        p2pServerAddress: `${ClusterManager.LocalHost}:${BIOS_P2P_PORT}`,
        p2pPeerAddresses: [],
        httpServerAddress: `${ClusterManager.LocalHost}${BIOS_HTTP_PORT}`,
        enableStaleProduction: true,
        producerNames: ["sysio"],
        k1Keys: [BIOS_K1_KEY],
        blsKeys: [BIOS_BLS_KEY],
        configPath: "/tmp/test/node_bios",
        dataPath: "/tmp/test/node_bios",
        genesisJson: "/tmp/test/node_bios/genesis.json",
        genesisTimestamp: "2026-03-27T00:00:00.000"
      })
      const s = cmd.join(" ")
      expect(cmd[0]).toBe("/opt/bin/nodeop")
      expect(s).toContain(formatK1SignatureProvider(BIOS_K1_KEY))
      expect(s).toContain(formatBLSSignatureProvider(BIOS_BLS_KEY))
      expect(s).toContain("sysio::producer_plugin")
      expect(s).toContain("--enable-stale-production")
      expect(s).toContain("--producer-name sysio")
      expect(s).toContain("--trace-no-abis")
      expect(s).toContain("--genesis-json /tmp/test/node_bios/genesis.json")
      expect(s).toContain("--genesis-timestamp 2026-03-27T00:00:00.000")
    })

    test("builds producer node start.cmd with peer addresses and no stale production", () => {
      const k1 = { publicKey: "PUB_K1_test123", privateKey: "PVT_K1_test456" }
      const bls = {
        publicKey: "PUB_BLS_test789",
        privateKey: "PVT_BLS_test012",
        proofOfPossession: "SIG_BLS_test"
      }
      const cmd = buildStartCmd({
        nodeopBinary: "/opt/bin/nodeop",
        p2pListenEndpoint: "0.0.0.0:9876",
        p2pServerAddress: "localhost:9876",
        p2pPeerAddresses: ["localhost:9776"],
        httpServerAddress: "localhost:8888",
        producerNames: ["defproducera", "defproducerb"],
        k1Keys: [k1],
        blsKeys: [bls],
        configPath: "/tmp/test/node_00",
        dataPath: "/tmp/test/node_00",
        genesisJson: "/tmp/test/node_00/genesis.json",
        genesisTimestamp: "2026-03-27T00:00:00.000"
      })
      const s = cmd.join(" ")
      expect(s).toContain(
        "wire-PUB_K1_test123,wire,wire,PUB_K1_test123,KEY:PVT_K1_test456"
      )
      expect(s).toContain(
        "wire-bls-PUB_BLS_test789,wire,wire_bls,PUB_BLS_test789,KEY:PVT_BLS_test012"
      )
      expect(s).toContain("--producer-name defproducera")
      expect(s).toContain("--producer-name defproducerb")
      expect(s).toContain("--p2p-peer-address localhost:9776")
      expect(s).not.toContain("--enable-stale-production")
    })
  })

  describe("keyGen.ts constants", () => {
    test("BIOS_K1_KEY matches the standard dev key", () => {
      expect(BIOS_K1_KEY.publicKey).toBe(DEV_K1_PUBLIC_KEY)
      expect(BIOS_K1_KEY.privateKey).toBe(DEV_K1_PRIVATE_KEY)
    })

    test("BIOS_BLS_KEY has correct prefixes", () => {
      expect(BIOS_BLS_KEY.publicKey).toMatch(/^PUB_BLS_/)
      expect(BIOS_BLS_KEY.privateKey).toMatch(/^PVT_BLS_/)
      expect(BIOS_BLS_KEY.proofOfPossession).toMatch(/^SIG_BLS_/)
    })

    test("formatK1SignatureProvider produces correct wire,wire,<key>,KEY:<priv> format", () => {
      const sp = formatK1SignatureProvider(BIOS_K1_KEY)
      expect(sp).toBe(
        `wire-${BIOS_K1_KEY.publicKey},wire,wire,${BIOS_K1_KEY.publicKey},KEY:${BIOS_K1_KEY.privateKey}`
      )
    })

    test("formatBLSSignatureProvider produces correct wire-bls,wire,wire_bls format", () => {
      const sp = formatBLSSignatureProvider(BIOS_BLS_KEY)
      expect(sp).toBe(
        `wire-bls-${BIOS_BLS_KEY.publicKey},wire,wire_bls,${BIOS_BLS_KEY.publicKey},KEY:${BIOS_BLS_KEY.privateKey}`
      )
    })
  })
})
