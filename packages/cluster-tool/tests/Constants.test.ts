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
      expect(Constants.OPP_SYSTEM_ACCOUNTS).toContain("sysio.authex")
    })
    it("maps OPP contract paths", () => {
      expect(Constants.OPP_CONTRACT_PATHS["sysio.opreg"]).toBe(
        "contracts/sysio.opreg"
      )
    })
  })

  describe("plugin sets", () => {
    // SHARED-25 AC#4 (D3): trace_api is the ONE role plugin whose presence is
    // gated (NodeConfig.runsTraceApiPlugin), so it cannot ride the
    // unconditional producer set — an entry here would re-arm it on the
    // production-shaped external tree's producer / bios nodes.
    it("keeps trace_api OUT of PRODUCER_PLUGINS", () => {
      expect([...Constants.PRODUCER_PLUGINS]).toEqual([
        "sysio::producer_plugin",
        "sysio::producer_api_plugin"
      ])
      expect([...Constants.PRODUCER_PLUGINS]).not.toContain(
        Constants.TRACE_API_PLUGIN
      )
    })

    it("carries the ONE trace-api plugin spelling both surfaces read", () => {
      expect(Constants.TRACE_API_PLUGIN).toBe("sysio::trace_api_plugin")
    })

    it("carries ONE spelling of each base plugin, and COMPOSES BASE_PLUGINS from them", () => {
      // The individual constants exist so a standalone artifact (the API node's
      // config.ini) can name the two it wants WITHOUT spreading BASE_PLUGINS —
      // otherwise a future cluster-wide base plugin would silently land in a
      // file the API-node baseline governs. The composition keeps the cluster
      // set byte-identical, so nothing is re-spelled to buy that.
      expect(Constants.NET_PLUGIN).toBe("sysio::net_plugin")
      expect(Constants.CHAIN_API_PLUGIN).toBe("sysio::chain_api_plugin")
      expect([...Constants.BASE_PLUGINS]).toEqual([
        Constants.NET_PLUGIN,
        Constants.CHAIN_API_PLUGIN
      ])
      expect([...Constants.BASE_PLUGINS]).toEqual([
        "sysio::net_plugin",
        "sysio::chain_api_plugin"
      ])
    })

    it("carries the ONE chain-state DB size option spelling (SHARED-31)", () => {
      // Consumed bare as an ini key + a yargs flag name, and as `--${…}` in the
      // nodeop argv — three surfaces, one string.
      expect(Constants.CHAIN_STATE_DB_SIZE_MB_OPTION).toBe(
        "chain-state-db-size-mb"
      )
      expect(Constants.CHAIN_STATE_DB_SIZE_MB_OPTION.startsWith("--")).toBe(
        false
      )
    })

    it("keeps producer_api in the unconditional producer set", () => {
      // Only trace_api moved out — producer_api stays role-gated but
      // deployment-blind (the bios/producer argv emits it on every cluster).
      expect([...Constants.PRODUCER_PLUGINS]).toContain(
        "sysio::producer_api_plugin"
      )
    })
  })

  describe("NODEOP_EXTRA_ARGS", () => {
    // SHARED-25: the ini these feed is read via `--config-dir` on BOTH launch
    // forms, so only PHASE-INDEPENDENT values may live here. The three deadline
    // knobs are phase- and role-dependent and belong solely to NodeopProcess's
    // companion constants — an entry here would resurrect a value the
    // post-bootstrap argv deliberately omits.
    it("carries exactly the phase-independent extras", () => {
      expect(Object.keys(Constants.NODEOP_EXTRA_ARGS).sort()).toEqual([
        "connectionCleanupPeriod",
        "voteThreads"
      ])
    })

    it("carries NO deadline knobs", () => {
      expect(Constants.NODEOP_EXTRA_ARGS).not.toHaveProperty(
        "maxTransactionTime"
      )
      expect(Constants.NODEOP_EXTRA_ARGS).not.toHaveProperty(
        "abiSerializerMaxTimeMs"
      )
      expect(Constants.NODEOP_EXTRA_ARGS).not.toHaveProperty(
        "httpMaxResponseTimeMs"
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
