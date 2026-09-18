import { SlugName, SysioContracts } from "@wireio/sdk-core"

import {
  availableCollateral,
  runActiveUnderwriters,
  runAssetRegistry,
  runExternalAssets,
  runPublicReserves,
  runRequestBacklog,
  runRouteQuotes,
  runRouteRegistry,
  runUnderwritingConfig,
  SwapReadinessSteps
} from "@wireio/cluster-tool/orchestration/steps/SwapReadinessSteps"
import { Report } from "@wireio/cluster-tool/report"

const chainCode = { value: SlugName.from("ETHEREUM") },
  tokenCode = { value: SlugName.from("ETH") },
  reserveCode = { value: SlugName.from("PRIMARY") },
  reserve: SysioContracts.SysioReservReserveRowType = {
    chain_code: chainCode,
    token_code: tokenCode,
    reserve_code: reserveCode,
    name: "Primary",
    description: "Public reserve",
    status: SysioContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
    reserve_chain_amount: 1_000,
    reserve_wire_amount: 1_000,
    source_token_precision: 9,
    connector_weight_bps: 5_000,
    creator_addr: {
      kind: SysioContracts.SysioReservChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    requested_wire_amount: 1_000,
    external_token_amount: 1_000,
    registered_at_ms: 0,
    activated_at_ms: 0,
    cancelled_at_ms: 0,
    is_private: false,
    owner: "",
    creator_pub_key: "",
    owner_fee_bps: 0,
    owner_fee_accrued: 0,
    owner_fee_lifetime: 0
  },
  operator: SysioContracts.SysioOpregOperatorEntryType = {
    account: "wireno.wacca",
    type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
    status: SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
    is_bootstrapped: false,
    balances: [
      {
        chain_code: chainCode,
        token_code: tokenCode,
        balance: 100,
        last_updated_ms: 0
      }
    ],
    registered_at: 0,
    available_at: 0,
    updated_at: 0,
    terminated_at: 0,
    status_reason: "",
    recent_actions: []
  }

describe("SwapReadinessSteps", () => {
  it("wires every planned Step to its named runner and typed input", () => {
    const pairs = [
      [SwapReadinessSteps.planUnderwritingConfig, runUnderwritingConfig],
      [SwapReadinessSteps.planActiveUnderwriters, runActiveUnderwriters],
      [SwapReadinessSteps.planExternalAssets, runExternalAssets],
      [SwapReadinessSteps.planAssetRegistry, runAssetRegistry],
      [SwapReadinessSteps.planPublicReserves, runPublicReserves],
      [SwapReadinessSteps.planRequestBacklog, runRequestBacklog],
      [SwapReadinessSteps.planRouteRegistry, runRouteRegistry],
      [SwapReadinessSteps.planRouteQuotes, runRouteQuotes]
    ] as const
    pairs.forEach(([planner, runner], index) => {
      const step = planner(Report.Actor.Sysio, `step-${index}`, "fixture", {
        timeoutMs: 123
      })
      expect(step.runner).toBe(runner)
      expect(step.input).toEqual({ kind: "SwapReadinessSteps.Input" })
      expect(step.options.timeoutMs).toBe(123)
    })
  })

  it("subtracts active locks and pending withdrawals from collateral", () => {
    const locks: SysioContracts.SysioUwritLockEntryType[] = [
        {
          lock_id: 1,
          uwreq_id: 1,
          underwriter: operator.account,
          chain_code: chainCode,
          token_code: tokenCode,
          reserve_code: reserveCode,
          amount: 20,
          created_at_ms: 0,
          expires_at_ms: 1,
          challenge_id: 0
        }
      ],
      withdrawals: SysioContracts.SysioOpregWithdrawRequestType[] = [
        {
          request_id: 1,
          account: operator.account,
          chain_code: chainCode,
          token_code: tokenCode,
          amount: 30,
          eligible_at_epoch: 1,
          requested_at_epoch: 0
        }
      ]
    expect(availableCollateral(operator, reserve, locks, withdrawals)).toBe(50n)
  })

  it("never reports negative available collateral", () => {
    const locks: SysioContracts.SysioUwritLockEntryType[] = [
      {
        lock_id: 1,
        uwreq_id: 1,
        underwriter: operator.account,
        chain_code: chainCode,
        token_code: tokenCode,
        reserve_code: reserveCode,
        amount: 101,
        created_at_ms: 0,
        expires_at_ms: 1,
        challenge_id: 0
      }
    ]
    expect(availableCollateral(operator, reserve, locks, [])).toBe(0n)
  })
})
