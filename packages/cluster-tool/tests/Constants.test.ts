import { Constants, ProtocolTiming } from "@wireio/cluster-tool/Constants"

describe("Constants", () => {
  describe("development keys", () => {
    it("derives a deterministic dev K1 public key (SYS-prefixed)", () => {
      expect(Constants.DEV_K1_PUBLIC_KEY).toMatch(/^SYS/)
      expect(Constants.DEV_K1_PRIVATE_KEY.length).toBeGreaterThan(0)
    })
    it("derives a deterministic dev BLS public key (PUB_BLS-prefixed)", () => {
      expect(Constants.DEV_BLS_PUBLIC_KEY).toMatch(/^PUB_BLS/)
      expect(Constants.DEV_BLS_PROOF_OF_POSSESSION.length).toBeGreaterThan(0)
    })
  })

  describe("account-name generators", () => {
    it("names batch operators by letter and wraps at 26", () => {
      expect(Constants.batchOperatorLabel(0)).toBe("batchop.a")
      expect(Constants.batchOperatorLabel(1)).toBe("batchop.b")
      expect(Constants.batchOperatorLabel(26)).toBe("batchop.a")
    })
    it("names underwriters by letter", () => {
      expect(Constants.underwriterLabel(0)).toBe("uwrit.a")
      expect(Constants.underwriterLabel(1)).toBe("uwrit.b")
    })
  })

  describe("formatSignatureProvider", () => {
    it("produces the nodeop signature-provider spec", () => {
      expect(
        Constants.formatSignatureProvider("n", "wire", "wire", "PUB", "PVT")
      ).toBe("n,wire,wire,PUB,KEY:PVT")
    })
    it("devSignatureProvider embeds the dev K1 key", () => {
      expect(Constants.devSignatureProvider()).toContain(
        Constants.DEV_K1_PUBLIC_KEY
      )
    })
  })

  describe("account + contract sets", () => {
    it("lists the OPP system accounts", () => {
      expect(Constants.OPP_SYSTEM_ACCOUNTS).toContain("sysio.epoch")
      expect(Constants.OPP_SYSTEM_ACCOUNTS).toContain("sysio.dclaim")
    })
    it("maps OPP contract paths", () => {
      expect(Constants.OPP_CONTRACT_PATHS["sysio.opreg"]).toBe(
        "contracts/sysio.opreg"
      )
    })
  })

  describe("EMISSION_CONFIG_DEFAULTS", () => {
    it("keeps the category split under 10000 bps", () => {
      const c = Constants.EMISSION_CONFIG_DEFAULTS
      expect(c.compute_bps + c.capex_bps + c.governance_bps).toBeLessThanOrEqual(
        10_000
      )
      expect(c.producer_bps + c.batch_op_bps).toBe(10_000)
    })
  })

  describe("EMISSION_CONFIG_DEFAULTS", () => {
    // Tier caps are TN_MAX_NODE_OWNERS in wire-sysio
    // contracts/sysio.system/include/sysio.system/emissions.hpp.
    const T1Cap = 21
    const T2Cap = 84
    const T3Cap = 1000
    /** 1,000,000,000 WIRE x 1e9 subunits — the supply issued to `sysio` at bootstrap. */
    const WireSupplySubunits = 1_000_000_000_000_000_000

    it("sets tier allocations PER OWNER, not per tier", () => {
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t1_allocation).toBe(7_500_000_000_000_000)
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t2_allocation).toBe(1_000_000_000_000_000)
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t3_allocation).toBe(100_000_000_000_000)
    })

    it("commits 341,500,000 WIRE at tier caps, inside the WIRE supply", () => {
      const { t1_allocation, t2_allocation, t3_allocation } =
        Constants.EMISSION_CONFIG_DEFAULTS
      const committed =
        t1_allocation * T1Cap + t2_allocation * T2Cap + t3_allocation * T3Cap
      expect(committed).toBe(341_500_000_000_000_000)
      expect(committed).toBeLessThan(WireSupplySubunits)
    })

    it("vests over 12 / 24 / 36 months on a 30-day month", () => {
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t1_duration).toBe(31_104_000)
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t2_duration).toBe(62_208_000)
      expect(Constants.EMISSION_CONFIG_DEFAULTS.t3_duration).toBe(93_312_000)
    })
  })
})

describe("ProtocolTiming", () => {
  it("pins each envelope class to its top value", () => {
    expect(ProtocolTiming.EpochExtensionMaxSec).toBe(30)
    expect(ProtocolTiming.CollateralVerifyBudgetMs).toBe(360_000)
    expect(ProtocolTiming.SingleHopBudgetMs).toBe(420_000)
    expect(ProtocolTiming.DoubleHopBudgetMs).toBe(840_000)
    expect(ProtocolTiming.PollDeadlineBufferMs).toBe(30_000)
  })

  it("orders the classes: collateral < single hop < double hop = 2x single", () => {
    expect(ProtocolTiming.CollateralVerifyBudgetMs).toBeLessThan(
      ProtocolTiming.SingleHopBudgetMs
    )
    expect(ProtocolTiming.DoubleHopBudgetMs).toBe(
      2 * ProtocolTiming.SingleHopBudgetMs
    )
  })

  it("effectiveEpochSec adds the max delivery extension", () => {
    expect(ProtocolTiming.effectiveEpochSec(60)).toBe(90)
    expect(ProtocolTiming.effectiveEpochSec(300)).toBe(330)
  })
})
