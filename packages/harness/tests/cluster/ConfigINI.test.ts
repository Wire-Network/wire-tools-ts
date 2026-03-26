import { generateConfigINI, type ConfigINIOptions } from "@wire-e2e-tests/harness/cluster/ConfigINI"

/** Minimal valid options for generateConfigINI. */
function minimalOpts(overrides?: Partial<ConfigINIOptions>): ConfigINIOptions {
  return {
    plugins: ["sysio::net_plugin", "sysio::chain_api_plugin"],
    p2pListenEndpoint: "0.0.0.0:9876",
    p2pServerAddress: "localhost:9876",
    httpServerAddress: "0.0.0.0:8888",
    ...overrides,
  }
}

describe("generateConfigINI", () => {
  it("produces key = value lines", () => {
    const ini = generateConfigINI(minimalOpts())
    const lines = ini.split("\n").filter(l => l.trim() && !l.startsWith("#"))
    for (const line of lines) {
      expect(line).toMatch(/^[\w-]+ = .+$/)
    }
  })

  it("includes all specified plugins", () => {
    const plugins = [
      "sysio::net_plugin",
      "sysio::chain_api_plugin",
      "sysio::producer_plugin",
    ]
    const ini = generateConfigINI(minimalOpts({ plugins }))
    for (const plugin of plugins) {
      expect(ini).toContain(`plugin = ${plugin}`)
    }
  })

  it("includes p2p and http endpoints", () => {
    const ini = generateConfigINI(minimalOpts())
    expect(ini).toContain("p2p-listen-endpoint = 0.0.0.0:9876")
    expect(ini).toContain("p2p-server-address = localhost:9876")
    expect(ini).toContain("http-server-address = 0.0.0.0:8888")
  })

  it("includes p2p peer addresses when specified", () => {
    const peers = ["localhost:9877", "localhost:9878"]
    const ini = generateConfigINI(minimalOpts({ p2pPeerAddresses: peers }))
    for (const peer of peers) {
      expect(ini).toContain(`p2p-peer-address = ${peer}`)
    }
  })

  it("includes producer names when specified", () => {
    const ini = generateConfigINI(
      minimalOpts({ producerNames: ["defproducera", "defproducerb"] })
    )
    expect(ini).toContain("producer-name = defproducera")
    expect(ini).toContain("producer-name = defproducerb")
  })

  it("includes signature providers when specified", () => {
    const sp = "wire-SOMEKEY,wire,wire,SOMEKEY,KEY:PRIVKEY"
    const ini = generateConfigINI(minimalOpts({ signatureProviders: [sp] }))
    expect(ini).toContain(`signature-provider = ${sp}`)
  })

  describe("httpInsecure=true", () => {
    it("adds CORS access-control-allow-origin header", () => {
      const ini = generateConfigINI(minimalOpts({ httpInsecure: true }))
      expect(ini).toContain("access-control-allow-origin = *")
    })

    it("adds access-control-allow-headers", () => {
      const ini = generateConfigINI(minimalOpts({ httpInsecure: true }))
      expect(ini).toContain("access-control-allow-headers = *")
    })

    it("disables http-validate-host", () => {
      const ini = generateConfigINI(minimalOpts({ httpInsecure: true }))
      expect(ini).toContain("http-validate-host = false")
    })

    it("enables verbose-http-errors", () => {
      const ini = generateConfigINI(minimalOpts({ httpInsecure: true }))
      expect(ini).toContain("verbose-http-errors = true")
    })
  })

  it("does not include insecure headers when httpInsecure is false/undefined", () => {
    const ini = generateConfigINI(minimalOpts({ httpInsecure: false }))
    expect(ini).not.toContain("access-control-allow-origin")
    expect(ini).not.toContain("http-validate-host")
  })

  it("writes read-mode when specified", () => {
    const ini = generateConfigINI(minimalOpts({ readMode: "irreversible" }))
    expect(ini).toContain("read-mode = irreversible")
  })

  it("does not write read-mode when not specified", () => {
    const ini = generateConfigINI(minimalOpts())
    expect(ini).not.toContain("read-mode")
  })

  describe("batch operator options", () => {
    it("includes batch-enabled when batchEnabled=true", () => {
      const ini = generateConfigINI(minimalOpts({ batchEnabled: true }))
      expect(ini).toContain("batch-enabled = true")
    })

    it("includes batch-operator-account when specified", () => {
      const ini = generateConfigINI(
        minimalOpts({ batchOperatorAccount: "batchop.a" })
      )
      expect(ini).toContain("batch-operator-account = batchop.a")
    })

    it("includes batch-epoch-poll-ms when specified", () => {
      const ini = generateConfigINI(minimalOpts({ batchEpochPollMs: 5000 }))
      expect(ini).toContain("batch-epoch-poll-ms = 5000")
    })

    it("includes batch-outpost-poll-ms when specified", () => {
      const ini = generateConfigINI(minimalOpts({ batchOutpostPollMs: 3000 }))
      expect(ini).toContain("batch-outpost-poll-ms = 3000")
    })

    it("includes batch-delivery-timeout-ms when specified", () => {
      const ini = generateConfigINI(
        minimalOpts({ batchDeliveryTimeoutMs: 10000 })
      )
      expect(ini).toContain("batch-delivery-timeout-ms = 10000")
    })
  })

  describe("underwriter options", () => {
    it("includes underwriter-enabled when specified", () => {
      const ini = generateConfigINI(minimalOpts({ underwriterEnabled: true }))
      expect(ini).toContain("underwriter-enabled = true")
    })

    it("includes underwriter-account when specified", () => {
      const ini = generateConfigINI(
        minimalOpts({ underwriterAccount: "uwrit.a" })
      )
      expect(ini).toContain("underwriter-account = uwrit.a")
    })
  })

  it("includes agent-name quoted when specified", () => {
    const ini = generateConfigINI(minimalOpts({ agentName: "test-node" }))
    expect(ini).toContain('agent-name = "test-node"')
  })

  it("includes enable-stale-production when set", () => {
    const ini = generateConfigINI(minimalOpts({ enableStaleProduction: true }))
    expect(ini).toContain("enable-stale-production = true")
  })

  it("includes chain-state-db-size-mb when specified", () => {
    const ini = generateConfigINI(minimalOpts({ chainStateDbSizeMb: 2048 }))
    expect(ini).toContain("chain-state-db-size-mb = 2048")
  })
})
