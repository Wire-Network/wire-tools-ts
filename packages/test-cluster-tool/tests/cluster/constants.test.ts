import {
  DEV_K1_PRIVATE_KEY,
  DEV_K1_PUBLIC_KEY,
  SYSTEM_ACCOUNTS,
  BASE_P2P_PORT,
  BASE_HTTP_PORT,
  BIOS_P2P_PORT,
  BIOS_HTTP_PORT,
  MAX_BLOCK_CPU_USAGE,
  MAX_TRANSACTION_CPU_USAGE,
  MAX_PRODUCERS,
  TOKEN_MAX_SUPPLY,
  CORE_SYMBOL,
  CORE_SYMBOL_PRECISION,
  CONTRACT_PATHS,
  OPP_CONTRACT_PATHS,
  BASE_PLUGINS,
  PRODUCER_PLUGINS,
  BATCH_OPERATOR_PLUGINS,
  UNDERWRITER_PLUGINS,
  batchOperatorAccountName,
  underwriterAccountName
} from "@wireio/test-cluster-tool/cluster/constants"

describe("constants", () => {
  describe("development keys", () => {
    it("DEV_K1_PRIVATE_KEY is a non-empty string", () => {
      expect(typeof DEV_K1_PRIVATE_KEY).toBe("string")
      expect(DEV_K1_PRIVATE_KEY.length).toBeGreaterThan(0)
    })

    it("DEV_K1_PUBLIC_KEY is a non-empty string", () => {
      expect(typeof DEV_K1_PUBLIC_KEY).toBe("string")
      expect(DEV_K1_PUBLIC_KEY.length).toBeGreaterThan(0)
    })

    it("DEV_K1_PUBLIC_KEY starts with SYS", () => {
      expect(DEV_K1_PUBLIC_KEY).toMatch(/^SYS/)
    })
  })

  describe("SYSTEM_ACCOUNTS", () => {
    it("is a non-empty array", () => {
      expect(Array.isArray(SYSTEM_ACCOUNTS)).toBe(true)
      expect(SYSTEM_ACCOUNTS.length).toBeGreaterThan(0)
    })

    it("includes sysio.token", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.token")
    })

    it("includes sysio.epoch", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.epoch")
    })

    it("includes sysio.msig", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.msig")
    })

    it("includes sysio.wrap", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.wrap")
    })

    it("includes sysio.roa", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.roa")
    })

    it("includes sysio.uwrit", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.uwrit")
    })

    it("has no duplicate entries", () => {
      const unique = new Set(SYSTEM_ACCOUNTS)
      expect(unique.size).toBe(SYSTEM_ACCOUNTS.length)
    })
  })

  describe("port bases", () => {
    it("BASE_P2P_PORT is a reasonable port number", () => {
      expect(BASE_P2P_PORT).toBeGreaterThanOrEqual(1024)
      expect(BASE_P2P_PORT).toBeLessThanOrEqual(65535)
    })

    it("BASE_HTTP_PORT is a reasonable port number", () => {
      expect(BASE_HTTP_PORT).toBeGreaterThanOrEqual(1024)
      expect(BASE_HTTP_PORT).toBeLessThanOrEqual(65535)
    })

    it("BIOS ports are below their base counterparts", () => {
      expect(BIOS_P2P_PORT).toBeLessThan(BASE_P2P_PORT)
      expect(BIOS_HTTP_PORT).toBeLessThan(BASE_HTTP_PORT)
    })

    it("BIOS ports are exactly base - 100", () => {
      expect(BIOS_P2P_PORT).toBe(BASE_P2P_PORT - 100)
      expect(BIOS_HTTP_PORT).toBe(BASE_HTTP_PORT - 100)
    })
  })

  describe("chain limits", () => {
    it("MAX_BLOCK_CPU_USAGE is 400000", () => {
      expect(MAX_BLOCK_CPU_USAGE).toBe(400000)
    })

    it("MAX_TRANSACTION_CPU_USAGE is 375000", () => {
      expect(MAX_TRANSACTION_CPU_USAGE).toBe(375000)
    })

    it("MAX_PRODUCERS is 21", () => {
      expect(MAX_PRODUCERS).toBe(21)
    })
  })

  describe("token parameters", () => {
    it("TOKEN_MAX_SUPPLY contains SYS", () => {
      expect(TOKEN_MAX_SUPPLY).toContain("SYS")
    })

    it("CORE_SYMBOL is SYS", () => {
      expect(CORE_SYMBOL).toBe("SYS")
    })

    it("CORE_SYMBOL_PRECISION is 4", () => {
      expect(CORE_SYMBOL_PRECISION).toBe(4)
    })
  })

  describe("plugins", () => {
    it("BASE_PLUGINS includes net_plugin and chain_api_plugin", () => {
      expect(BASE_PLUGINS).toContain("sysio::net_plugin")
      expect(BASE_PLUGINS).toContain("sysio::chain_api_plugin")
    })

    it("PRODUCER_PLUGINS includes producer_plugin", () => {
      expect(PRODUCER_PLUGINS).toContain("sysio::producer_plugin")
    })

    it("BATCH_OPERATOR_PLUGINS includes batch_operator_plugin", () => {
      expect(BATCH_OPERATOR_PLUGINS).toContain("sysio::batch_operator_plugin")
    })

    it("UNDERWRITER_PLUGINS includes underwriter_plugin", () => {
      expect(UNDERWRITER_PLUGINS).toContain("sysio::underwriter_plugin")
    })
  })

  describe("CONTRACT_PATHS", () => {
    it("has sysio.bios entry", () => {
      expect(CONTRACT_PATHS["sysio.bios"]).toBeDefined()
    })

    it("has sysio.token entry", () => {
      expect(CONTRACT_PATHS["sysio.token"]).toBeDefined()
    })

    it("has sysio.system entry", () => {
      expect(CONTRACT_PATHS["sysio.system"]).toBeDefined()
    })

    it("has sysio.msig entry", () => {
      expect(CONTRACT_PATHS["sysio.msig"]).toBeDefined()
    })

    it("all paths are non-empty strings", () => {
      for (const [key, val] of Object.entries(CONTRACT_PATHS)) {
        expect(typeof val).toBe("string")
        expect(val.length).toBeGreaterThan(0)
      }
    })
  })

  describe("OPP_CONTRACT_PATHS", () => {
    it("has sysio.epoch entry", () => {
      expect(OPP_CONTRACT_PATHS["sysio.epoch"]).toBeDefined()
    })

    it("has sysio.uwrit entry", () => {
      expect(OPP_CONTRACT_PATHS["sysio.uwrit"]).toBeDefined()
    })
  })

  describe("batchOperatorAccountName", () => {
    it("generates batchop.a for index 0", () => {
      expect(batchOperatorAccountName(0)).toBe("batchop.a")
    })

    it("generates batchop.b for index 1", () => {
      expect(batchOperatorAccountName(1)).toBe("batchop.b")
    })

    it("generates batchop.z for index 25", () => {
      expect(batchOperatorAccountName(25)).toBe("batchop.z")
    })

    it("wraps around after z (index 26 -> batchop.a)", () => {
      expect(batchOperatorAccountName(26)).toBe("batchop.a")
    })

    it("generates unique names for indices 0..25", () => {
      const names = Array.from({ length: 26 }, (_, i) =>
        batchOperatorAccountName(i)
      )
      const unique = new Set(names)
      expect(unique.size).toBe(26)
    })
  })

  describe("underwriterAccountName", () => {
    it("generates uwrit.a for index 0", () => {
      expect(underwriterAccountName(0)).toBe("uwrit.a")
    })

    it("generates uwrit.b for index 1", () => {
      expect(underwriterAccountName(1)).toBe("uwrit.b")
    })

    it("generates uwrit.z for index 25", () => {
      expect(underwriterAccountName(25)).toBe("uwrit.z")
    })

    it("generates unique names for indices 0..25", () => {
      const names = Array.from({ length: 26 }, (_, i) =>
        underwriterAccountName(i)
      )
      const unique = new Set(names)
      expect(unique.size).toBe(26)
    })
  })
})
