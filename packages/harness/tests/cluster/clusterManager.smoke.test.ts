import Fs from "fs"
import Path from "path"
import os from "os"
import { ClusterManager } from "@wire-e2e-tests/harness/cluster/ClusterManager"

/**
 * Smoke test for ClusterManager file-generation logic.
 *
 * This test exercises the directory structure creation, genesis.json writing,
 * config.ini generation, and cluster-config.json output WITHOUT actually
 * starting nodeop processes.  We achieve this by:
 *   1. Calling create() with a fake buildDir (it never actually spawns nodeop
 *      because we mock ProcessManager.spawn and the bootstrap helpers).
 *   2. Verifying the generated files on disk.
 */

describe("ClusterManager smoke test (file generation only)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(os.tmpdir(), "cluster-smoke-"))
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Helper: call the private methods on ClusterManager that handle
   * file generation (directory structure, configs, cluster-config.json)
   * without going through the full create() which tries to start nodes.
   */
  function generateClusterFiles(opts?: {
    nodeCount?: number
    producerCount?: number
    batchOperatorCount?: number
    underwriterCount?: number
  }) {
    const cm = new ClusterManager()
    const cfg = {
      buildDir: "/fake/build",
      chainDir: tmpDir,
      producerCount: opts?.producerCount ?? 4,
      nodeCount: opts?.nodeCount ?? 2,
      httpSecure: false,
      batchOperatorCount: opts?.batchOperatorCount ?? 1,
      underwriterCount: opts?.underwriterCount ?? 1,
    }

    // Access private methods via cast — these are the file-only methods
    const cmAny = cm as any

    // 1. Create directory structure
    cmAny.ensureDirectoryStructure(cfg)

    // 2. Write genesis.json (mirroring what create() does)
    const { generateGenesis } = require("../../src/cluster/genesis")
    const genesisContent = generateGenesis()
    Fs.writeFileSync(
      Path.join(tmpDir, "genesis.json"),
      JSON.stringify(genesisContent, null, 2),
      "utf-8"
    )

    // 3. Generate all config.ini files
    cmAny.generateAllConfigs(cfg)

    // 4. Write cluster-config.json
    const producerNodes = cmAny.buildProducerNodeStates(cfg)
    const batchOpNodes = cmAny.buildBatchOperatorNodeStates(cfg)
    const underwriterNodes = cmAny.buildUnderwriterNodeStates(cfg)
    cmAny.writeClusterConfigJson(cfg, producerNodes, batchOpNodes, underwriterNodes)

    return { cfg, producerNodes, batchOpNodes, underwriterNodes }
  }

  it("creates genesis.json with expected structure", () => {
    generateClusterFiles()

    const genesisPath = Path.join(tmpDir, "genesis.json")
    expect(Fs.existsSync(genesisPath)).toBe(true)

    const genesis = JSON.parse(Fs.readFileSync(genesisPath, "utf-8"))
    expect(genesis).toHaveProperty("initial_timestamp")
    expect(genesis).toHaveProperty("initial_key")
    expect(genesis).toHaveProperty("initial_configuration")
    expect(genesis.initial_configuration).toHaveProperty("max_block_cpu_usage")
  })

  it("creates bios node directory and config.ini", () => {
    generateClusterFiles()

    const biosDir = Path.join(tmpDir, "data", "node_bios")
    expect(Fs.existsSync(biosDir)).toBe(true)
    expect(Fs.existsSync(Path.join(biosDir, "blocks"))).toBe(true)

    const configPath = Path.join(biosDir, "config.ini")
    expect(Fs.existsSync(configPath)).toBe(true)

    const ini = Fs.readFileSync(configPath, "utf-8")
    expect(ini).toContain("plugin = sysio::net_plugin")
    expect(ini).toContain("enable-stale-production = true")
    expect(ini).toContain("producer-name = sysio")
  })

  it("creates producer node directories with config.ini files", () => {
    const { cfg } = generateClusterFiles({ nodeCount: 3 })

    for (let i = 0; i < cfg.nodeCount; i++) {
      const nodeDir = Path.join(
        tmpDir,
        "data",
        `node_${String(i).padStart(2, "0")}`
      )
      expect(Fs.existsSync(nodeDir)).toBe(true)
      expect(Fs.existsSync(Path.join(nodeDir, "blocks"))).toBe(true)

      const configPath = Path.join(nodeDir, "config.ini")
      expect(Fs.existsSync(configPath)).toBe(true)

      const ini = Fs.readFileSync(configPath, "utf-8")
      expect(ini).toContain("plugin = sysio::net_plugin")
      expect(ini).toContain("http-server-address")
      expect(ini).toContain("p2p-listen-endpoint")
    }
  })

  it("creates batch operator node directories with config.ini files", () => {
    const { cfg } = generateClusterFiles({ batchOperatorCount: 2 })

    for (let i = 0; i < cfg.batchOperatorCount; i++) {
      const nodeDir = Path.join(
        tmpDir,
        "data",
        `node_batchop_${String(i).padStart(2, "0")}`
      )
      expect(Fs.existsSync(nodeDir)).toBe(true)

      const configPath = Path.join(nodeDir, "config.ini")
      expect(Fs.existsSync(configPath)).toBe(true)

      const ini = Fs.readFileSync(configPath, "utf-8")
      expect(ini).toContain("batch-enabled = true")
      expect(ini).toContain("batch-operator-account = batchop.")
      expect(ini).toContain("read-mode = irreversible")
      expect(ini).toContain("plugin = sysio::batch_operator_plugin")
    }
  })

  it("creates underwriter node directories with config.ini files", () => {
    const { cfg } = generateClusterFiles({ underwriterCount: 2 })

    for (let i = 0; i < cfg.underwriterCount; i++) {
      const nodeDir = Path.join(
        tmpDir,
        "data",
        `node_uwrit_${String(i).padStart(2, "0")}`
      )
      expect(Fs.existsSync(nodeDir)).toBe(true)

      const configPath = Path.join(nodeDir, "config.ini")
      expect(Fs.existsSync(configPath)).toBe(true)

      const ini = Fs.readFileSync(configPath, "utf-8")
      expect(ini).toContain("underwriter-enabled = true")
      expect(ini).toContain("underwriter-account = uwrit.")
      expect(ini).toContain("read-mode = irreversible")
      expect(ini).toContain("plugin = sysio::underwriter_plugin")
    }
  })

  it("creates a wallet directory", () => {
    generateClusterFiles()
    expect(Fs.existsSync(Path.join(tmpDir, "wallet"))).toBe(true)
  })

  it("writes cluster-config.json with expected structure", () => {
    generateClusterFiles({ nodeCount: 2, producerCount: 4, batchOperatorCount: 1, underwriterCount: 1 })

    const ccPath = Path.join(tmpDir, "cluster-config.json")
    expect(Fs.existsSync(ccPath)).toBe(true)

    const cc = JSON.parse(Fs.readFileSync(ccPath, "utf-8"))
    expect(cc).toHaveProperty("config")
    expect(cc).toHaveProperty("keys")

    // Config section
    expect(cc.config.producerCount).toBe(4)
    expect(cc.config.nodeCount).toBe(2)
    expect(cc.config.batchOperatorCount).toBe(1)
    expect(cc.config.underwriterCount).toBe(1)

    // Producers array
    expect(Array.isArray(cc.config.producers)).toBe(true)
    expect(cc.config.producers.length).toBe(4)
    expect(cc.config.producers[0]).toHaveProperty("name")
    expect(cc.config.producers[0]).toHaveProperty("httpPort")
    expect(cc.config.producers[0]).toHaveProperty("p2pPort")

    // Nodes array
    expect(Array.isArray(cc.config.nodes)).toBe(true)
    expect(cc.config.nodes.length).toBe(2)

    // Batch operators
    expect(Array.isArray(cc.config.batchOperators)).toBe(true)
    expect(cc.config.batchOperators.length).toBe(1)
    expect(cc.config.batchOperators[0]).toHaveProperty("account")

    // Underwriters
    expect(Array.isArray(cc.config.underwriters)).toBe(true)
    expect(cc.config.underwriters.length).toBe(1)
    expect(cc.config.underwriters[0]).toHaveProperty("account")
  })

  it("cluster-config.json keys section includes sysio and producer accounts", () => {
    generateClusterFiles({ producerCount: 4 })

    const cc = JSON.parse(
      Fs.readFileSync(Path.join(tmpDir, "cluster-config.json"), "utf-8")
    )

    expect(cc.keys).toHaveProperty("sysio")
    expect(cc.keys.sysio.keys[0]).toHaveProperty("private")
    expect(cc.keys.sysio.keys[0]).toHaveProperty("public")

    // All 4 defproducers should have keys
    expect(cc.keys).toHaveProperty("defproducera")
    expect(cc.keys).toHaveProperty("defproducerb")
    expect(cc.keys).toHaveProperty("defproducerc")
    expect(cc.keys).toHaveProperty("defproducerd")
  })

  it("config.ini files contain correct port assignments", () => {
    generateClusterFiles({ nodeCount: 2 })

    // node_00 should use BASE ports + 0
    const ini0 = Fs.readFileSync(
      Path.join(tmpDir, "data", "node_00", "config.ini"),
      "utf-8"
    )
    expect(ini0).toContain("http-server-address = 0.0.0.0:8888")
    expect(ini0).toContain("p2p-listen-endpoint = 0.0.0.0:9876")

    // node_01 should use BASE ports + 1
    const ini1 = Fs.readFileSync(
      Path.join(tmpDir, "data", "node_01", "config.ini"),
      "utf-8"
    )
    expect(ini1).toContain("http-server-address = 0.0.0.0:8889")
    expect(ini1).toContain("p2p-listen-endpoint = 0.0.0.0:9877")
  })

  it("bios config.ini includes bios-specific ports", () => {
    generateClusterFiles()

    const biosIni = Fs.readFileSync(
      Path.join(tmpDir, "data", "node_bios", "config.ini"),
      "utf-8"
    )
    expect(biosIni).toContain("http-server-address = 0.0.0.0:8788")
    expect(biosIni).toContain("p2p-listen-endpoint = 0.0.0.0:9776")
  })
})
