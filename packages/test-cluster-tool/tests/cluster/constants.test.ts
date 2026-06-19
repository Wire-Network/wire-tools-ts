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
  OPP_SYSTEM_ACCOUNTS,
  BASE_PLUGINS,
  PRODUCER_PLUGINS,
  BATCH_OPERATOR_PLUGINS,
  UNDERWRITER_PLUGINS,
  batchOperatorAccountName,
  underwriterAccountName,
  BOOTSTRAP_NODE_OWNER,
  DEFAULT_WALLET_NAME,
  ROA_TOTAL_SYS,
  ROA_BYTES_PER_UNIT
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

    it("includes sysio.reserv", () => {
      expect(SYSTEM_ACCOUNTS).toContain("sysio.reserv")
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

  describe("ROA pool sizing", () => {
    // ROA_TOTAL_SYS and ROA_BYTES_PER_UNIT are passed verbatim to
    // sysio.roa::activateroa, which converts the asset's SMALLEST units to
    // bytes (total RAM = amount * bytes_per_unit). These two values therefore
    // size the chain's entire RAM pool, so pin them to guard against a silent
    // drift. bytes_per_unit must also divide the contract's newaccount_ram
    // (1144 = 104 * 11), which the contract enforces via check_divisible_byte_price.
    it('ROA_TOTAL_SYS is "75496.0000 SYS"', () => {
      expect(ROA_TOTAL_SYS).toBe("75496.0000 SYS")
    })

    it("ROA_BYTES_PER_UNIT is 104", () => {
      expect(ROA_BYTES_PER_UNIT).toBe(104)
    })

    it("ROA_BYTES_PER_UNIT divides the 1144-byte newaccount_ram", () => {
      expect(1144 % ROA_BYTES_PER_UNIT).toBe(0)
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

    it("has sysio.reserv entry", () => {
      expect(OPP_CONTRACT_PATHS["sysio.reserv"]).toBeDefined()
    })
  })

  describe("OPP_SYSTEM_ACCOUNTS / OPP_CONTRACT_PATHS / SYSTEM_ACCOUNTS sync", () => {
    // The three lists feed three Phase-14-era bootstrap loops in
    // `ClusterManager.ts` (account creation, contract deployment, sysio.code
    // grant). If they ever drift apart — e.g. an account makes it into the
    // grant loop but is missing from account creation — bootstrap fails at
    // `updateauth` with an `unsatisfied_authorization` error because the
    // wallet has no key for an account that doesn't exist. Lock the
    // invariant in tests so the next OPP contract addition can't repeat it.
    it("every OPP_SYSTEM_ACCOUNTS account has an OPP_CONTRACT_PATHS entry", () => {
      const contractKeys = new Set(Object.keys(OPP_CONTRACT_PATHS))
      const missing = OPP_SYSTEM_ACCOUNTS.filter(a => !contractKeys.has(a))
      expect(missing).toEqual([])
    })

    it("every OPP_SYSTEM_ACCOUNTS account is also in SYSTEM_ACCOUNTS", () => {
      const sysAccounts = new Set<string>(SYSTEM_ACCOUNTS)
      const missing = OPP_SYSTEM_ACCOUNTS.filter(a => !sysAccounts.has(a))
      expect(missing).toEqual([])
    })

    it("every OPP_CONTRACT_PATHS account is in OPP_SYSTEM_ACCOUNTS", () => {
      const oppAccounts = new Set<string>(OPP_SYSTEM_ACCOUNTS)
      const missing = Object.keys(OPP_CONTRACT_PATHS).filter(
        k => !oppAccounts.has(k)
      )
      expect(missing).toEqual([])
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

  describe("BOOTSTRAP_NODE_OWNER", () => {
    it("is the wireno bootstrap node-owner account", () => {
      expect(BOOTSTRAP_NODE_OWNER).toBe("wireno")
    })

    it("is a valid sysio account name", () => {
      expect(typeof BOOTSTRAP_NODE_OWNER).toBe("string")
      expect(BOOTSTRAP_NODE_OWNER.length).toBeGreaterThan(0)
      expect(BOOTSTRAP_NODE_OWNER.length).toBeLessThanOrEqual(12)
      expect(BOOTSTRAP_NODE_OWNER).toMatch(/^[a-z1-5.]+$/)
    })
  })

  describe("DEFAULT_WALLET_NAME", () => {
    it("is the kiod default wallet the bootstrap creates", () => {
      expect(DEFAULT_WALLET_NAME).toBe("default")
    })
  })
})
