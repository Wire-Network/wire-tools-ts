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

  describe("operator-label generators", () => {
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

  describe("irreversibilityBudgetMs", () => {
    it("pins the two constants the budget is built from", () => {
      expect(ProtocolTiming.IrreversibilityBaseMs).toBe(60_000)
      expect(ProtocolTiming.IrreversibilityPerFinalizerMs).toBe(6_000)
    })

    it("is the floor plus one increment per finalizer", () => {
      expect(ProtocolTiming.irreversibilityBudgetMs(1)).toBe(66_000)
      expect(ProtocolTiming.irreversibilityBudgetMs(3)).toBe(78_000)
      expect(ProtocolTiming.irreversibilityBudgetMs(21)).toBe(186_000)
    })

    // The budget exists because a flat 60s failed `create-acct` on 2026-08-04
    // against a MEASURED 49.4s irreversibility at 21 finalizers. If this margin
    // ever drops back toward 1x, the timeout it was written to prevent is armed
    // again — so the relationship is pinned, not just the arithmetic.
    it("clears the measured 21-finalizer latency with real margin", () => {
      const measuredMs = 49_400,
        budget = ProtocolTiming.irreversibilityBudgetMs(21)
      expect(budget).toBeGreaterThan(measuredMs * 3)
    })

    it("keeps small dev/flow topologies near the previous flat budget", () => {
      // Every flow bootstraps a handful of finalizers; the floor must not make
      // those runs materially slower to fail than the 60s they used to get.
      ;[1, 2, 3].forEach(count =>
        expect(ProtocolTiming.irreversibilityBudgetMs(count)).toBeLessThanOrEqual(
          80_000
        )
      )
    })

    it("never returns less than the single-finalizer budget", () => {
      // 0 is reachable: `WireClientConfig.finalizerCount` is optional and
      // `withFinality` passes `?? 0`, so the floor is load-bearing, not defensive.
      const floor = ProtocolTiming.irreversibilityBudgetMs(1)
      expect(ProtocolTiming.irreversibilityBudgetMs(0)).toBe(floor)
      expect(ProtocolTiming.irreversibilityBudgetMs(-5)).toBe(floor)
    })

    it("grows monotonically with the finalizer set", () => {
      const budgets = [1, 5, 9, 21, 43].map(
        ProtocolTiming.irreversibilityBudgetMs
      )
      budgets.slice(1).forEach((budget, index) => {
        expect(budget).toBeGreaterThan(budgets[index])
      })
    })
  })
})
