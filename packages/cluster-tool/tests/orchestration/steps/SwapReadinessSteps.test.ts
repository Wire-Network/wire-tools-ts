import {
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Steps } from "@wireio/cluster-tool/orchestration"
import {
  ReadinessContext,
  ReadinessOutputs
} from "@wireio/cluster-tool/readiness"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const FullCollateral = 1_000_000_000,
  EthereumChainCode = { value: 1 },
  SolanaChainCode = { value: 2 },
  EthereumTokenCode = { value: 3 },
  SolanaTokenCode = { value: 4 },
  CollateralRequirements: SysioContracts.SysioOpregChainMinBondType[] = [
    {
      chain_code: EthereumChainCode,
      token_code: EthereumTokenCode,
      min_bond: FullCollateral,
      config_timestamp_ms: 0
    },
    {
      chain_code: SolanaChainCode,
      token_code: SolanaTokenCode,
      min_bond: FullCollateral,
      config_timestamp_ms: 0
    }
  ],
  ActiveExternalChains: SysioContracts.SysioChainsChainRowType[] = [
    {
      code: EthereumChainCode,
      kind: SysioContracts.SysioChainsChainkind.CHAIN_KIND_EVM,
      external_chain_id: 31_337,
      name: "Ethereum",
      description: "Ethereum outpost",
      is_depot: false,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    },
    {
      code: SolanaChainCode,
      kind: SysioContracts.SysioChainsChainkind.CHAIN_KIND_SVM,
      external_chain_id: 0,
      name: "Solana",
      description: "Solana outpost",
      is_depot: false,
      active: true,
      registered_at_ms: 0,
      activated_at_ms: 0
    }
  ],
  OperatorConfig: SysioContracts.SysioOpregOpConfigType = {
    req_prod_collat: [],
    req_batchop_collat: [],
    req_uw_collat: CollateralRequirements,
    max_available_producers: 1,
    max_available_batch_ops: 1,
    max_available_underwriters: 1,
    terminate_prune_delay_ms: 0,
    terminate_max_consecutive_misses: 1,
    terminate_max_pct_misses_24h: 1,
    terminate_window_ms: 1
  }

function underwriter(
  status: SysioContracts.SysioOpregOperatorEntryType["status"]
): SysioContracts.SysioOpregOperatorEntryType {
  return {
    account: "wireno.wacca",
    type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
    status,
    is_bootstrapped: false,
    balances: CollateralRequirements.map(requirement => ({
      chain_code: requirement.chain_code,
      token_code: requirement.token_code,
      balance: FullCollateral,
      last_updated_ms: 0
    })),
    registered_at: 0,
    available_at: 0,
    updated_at: 0,
    terminated_at: 0,
    status_reason: "",
    recent_actions: []
  }
}

function readinessContext(
  operator: SysioContracts.SysioOpregOperatorEntryType
): ReadinessContext {
  const context = new ReadinessContext(
    {
      feature: ClusterReadinessFeature.swap,
      catalogUrl: "https://catalog.example",
      requestedWireChainId: "a".repeat(64),
      endpoints: [],
      catalogRecordCount: 0,
      catalogErrors: [],
      observationMs: 1,
      timeoutMs: 1,
      report: { path: "/tmp", basename: "readiness", formats: [] }
    },
    getLogger("swap-readiness-steps-test")
  )
  jest
    .spyOn(context.wireSystem.opreg.tables.opconfig, "query")
    .mockResolvedValue({ rows: [OperatorConfig], more: false })
  jest
    .spyOn(context.wireSystem.opreg.tables.operators, "query")
    .mockResolvedValue({ rows: [operator], more: false })
  jest
    .spyOn(context.wireSystem.chains.tables.chains, "query")
    .mockResolvedValue({ rows: ActiveExternalChains, more: false })
  return context
}

function activeUnderwritersStep() {
  return Steps.readiness.swap.planActiveUnderwriters(
    Report.Actor.Underwriter,
    "active-underwriters",
    "Verify an active underwriter satisfies the collateral matrix",
    {}
  )
}

describe("SwapReadinessSteps", () => {
  it("accepts a non-bootstrapped ACTIVE underwriter with full collateral", async () => {
    const context = readinessContext(
        underwriter(
          SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
        )
      ),
      step = activeUnderwritersStep()

    await step.runner(context, step.input, new AbortController().signal)

    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.pass,
        evidence: {
          accounts: ["wireno.wacca"],
          requiredCollateralEntries: CollateralRequirements.length
        }
      })
    ])
  })

  it("rejects a fully collateralized underwriter that is not ACTIVE", async () => {
    const context = readinessContext(
        underwriter(
          SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_WARMUP
        )
      ),
      step = activeUnderwritersStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow(
      "No ACTIVE underwriter satisfies every configured collateral minimum"
    )
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        evidence: {
          requiredCollateralEntries: CollateralRequirements.length,
          activeUnderwriters: []
        }
      })
    ])
  })
})
