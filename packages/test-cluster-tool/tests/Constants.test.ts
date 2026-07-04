import { Constants, ProtocolTiming } from "@wireio/test-cluster-tool/Constants"

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
      expect(Constants.batchOperatorAccountName(0)).toBe("batchop.a")
      expect(Constants.batchOperatorAccountName(1)).toBe("batchop.b")
      expect(Constants.batchOperatorAccountName(26)).toBe("batchop.a")
    })
    it("names underwriters by letter", () => {
      expect(Constants.underwriterAccountName(0)).toBe("uwrit.a")
      expect(Constants.underwriterAccountName(1)).toBe("uwrit.b")
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
})

describe("ProtocolTiming", () => {
  it("pins each envelope class to its top value", () => {
    expect(ProtocolTiming.EpochExtensionMaxSec).toBe(30)
    expect(ProtocolTiming.CollateralVerifyBudgetMs).toBe(360_000)
    expect(ProtocolTiming.SingleHopBudgetMs).toBe(420_000)
    expect(ProtocolTiming.DoubleHopBudgetMs).toBe(840_000)
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
