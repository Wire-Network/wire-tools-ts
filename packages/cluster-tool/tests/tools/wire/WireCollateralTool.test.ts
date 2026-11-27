import {
  createUniformOutpostEpochDurations,
  OutpostChainCodenames,
  type ChainTokenAmount
} from "@wireio/cluster-tool-shared"
import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { Logger } from "@wireio/shared"

import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool/Constants"
import { Steps, type ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireCollateralTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../../orchestration/outputs/operatorAccountFixture.js"

const WireCode = SlugName.from("WIRE"),
  EthereumChainCode = SlugName.from("ETHEREUM"),
  LiqEthCode = SlugName.from("LIQETH"),
  OperatorLabel = "uwa",
  OneWire = 1_000_000_000n,
  signal = new AbortController().signal

/** A `(chain, token)` collateral amount in depot atomic units. */
function collateral(chainCode: number, tokenCode: number, amount: bigint): ChainTokenAmount {
  return {
    chain_code: chainCode,
    amount: TokenAmount.create({ tokenCode: BigInt(tokenCode), amount })
  }
}

/** A fixture context holding one provisioned operator, and that operator's on-chain account. */
interface OperatorContext {
  ctx: ClusterBuildContext
  account: string
}

/** A fixture context with the underwriter `uwa` provisioned; returns its on-chain account. */
function operatorContext(
  overrides: Parameters<typeof fixtureContext>[0] = {}
): OperatorContext {
  const ctx = fixtureContext(overrides),
    operator = fixtureOperatorAccount(OperatorLabel, OperatorType.UNDERWRITER)
  ctx.keyStore.setOperator(operator)
  return { ctx, account: operator.account }
}

/** One `sysio.opreg::operators` row carrying the given balance entries. */
function operatorRow(
  account: string,
  balances: SysioContracts.SysioOpregBalanceEntryType[],
  recentActions: SysioContracts.SysioOpregOperatoractionlogType[] = []
): SysioContracts.SysioOpregOperatorEntryType {
  return {
    account,
    type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
    status: SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
    is_bootstrapped: false,
    balances,
    registered_at: 0,
    available_at: 0,
    updated_at: 0,
    terminated_at: 0,
    status_reason: "",
    recent_actions: recentActions
  }
}

/** A `recent_actions` entry recording a withdraw request the contract refused with `reason`. */
function refusedWithdrawLog(reason: string): SysioContracts.SysioOpregOperatoractionlogType {
  return {
    action: {
      action_type: SysioContracts.SysioOpregActiontype.ACTION_TYPE_WITHDRAW_REQUEST,
      op_address: { kind: SysioContracts.SysioOpregChainkind.CHAIN_KIND_WIRE, address: "" },
      type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
      status: SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
      amount: { token_code: { value: WireCode }, amount: { value: 42 } },
      request_id: { value: 0 },
      chain_code: { value: WireCode },
      reason: "",
      reserve_code: { value: 0 }
    },
    success: false,
    timestamp: { value: 0 },
    error_message: reason
  }
}

/** One `sysio.opreg::wtdwqueue` row on the `(WIRE, token)` bucket. */
function withdrawRequest(
  requestId: number,
  account: string,
  token: string,
  amount: bigint
): SysioContracts.SysioOpregWithdrawRequestType {
  return {
    request_id: requestId,
    account,
    chain_code: "WIRE",
    token_code: token,
    amount: amount.toString(),
    eligible_at_economic_epoch: 3,
    consensus_waits: OutpostChainCodenames.map(chain => ({
      chain_code: chain,
      eligible_at_epoch: 3
    })),
    requested_at_economic_epoch: 1
  }
}

/** Serve `before` from the first `wtdwqueue` read (pre-push) and `after` from the second. */
function serveWithdrawQueue(
  ctx: ClusterBuildContext,
  before: SysioContracts.SysioOpregWithdrawRequestType[],
  after: SysioContracts.SysioOpregWithdrawRequestType[]
): void {
  const contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
  jest
    .spyOn(contract.tables.wtdwqueue, "query")
    .mockResolvedValueOnce({ rows: before, more: false })
    .mockResolvedValueOnce({ rows: after, more: false })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
}

/** One balance entry on the `(chain, token)` row. */
function balanceEntry(
  chain: string,
  token: string,
  balance: bigint
): SysioContracts.SysioOpregBalanceEntryType {
  return {
    chain_code: chain,
    token_code: token,
    balance: balance.toString(),
    last_updated_ms: 0,
    shadow_yield: { index_checkpoint: "0", owed_wire: 0 }
  }
}

/** Serve `rows` from the fixture context's `operators` table. */
function serveOperators(
  ctx: ClusterBuildContext,
  rows: SysioContracts.SysioOpregOperatorEntryType[]
): void {
  const contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
  jest.spyOn(contract.tables.operators, "query").mockResolvedValue({ rows, more: false })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
}

/** Serve `rows` from the fixture context's `remitclaims` table. */
function serveRemitClaims(
  ctx: ClusterBuildContext,
  rows: SysioContracts.SysioOpregRemitClaimType[]
): void {
  const contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
  jest.spyOn(contract.tables.remitclaims, "query").mockResolvedValue({ rows, more: false })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
}

describe("WireCollateralTool", () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe("planFunding", () => {
    it("captures the operator handle and the WIRE amount, and binds runFunding", () => {
      const amount = collateral(WireCode, WireCode, OneWire),
        step = WireCollateralTool.planFunding(
          Report.Actor.Underwriter,
          "fund-uwa",
          "fund uwa",
          {},
          OperatorLabel,
          amount
        )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.FundingInput",
        operatorLabel: OperatorLabel,
        collateral: amount
      })
      expect(step.runner).toBe(WireCollateralTool.runFunding)
    })

    it("refuses a non-WIRE token — only WIRE has a funding path", () => {
      expect(() =>
        WireCollateralTool.planFunding(
          Report.Actor.Underwriter,
          "fund-uwa",
          "fund uwa",
          {},
          OperatorLabel,
          collateral(WireCode, LiqEthCode, OneWire)
        )
      ).toThrow(/only WIRE has a harness funding path, got LIQETH/)
    })

    it("runFunding transfers the WIRE from sysio to the operator's ON-CHAIN account", async () => {
      const { ctx, account } = operatorContext(),
        transfer = jest
          .spyOn(Steps.contracts.sysio.token, "runTransfer")
          .mockResolvedValue(undefined)
      await WireCollateralTool.runFunding(
        ctx,
        {
          kind: "WireCollateralTool.FundingInput",
          operatorLabel: OperatorLabel,
          collateral: collateral(WireCode, WireCode, OneWire + 5n)
        },
        signal
      )
      expect(account).not.toBe(OperatorLabel)
      expect(transfer).toHaveBeenCalledWith(
        ctx,
        {
          kind: "TokenContractSteps.TransferInput",
          data: {
            from: WireCollateralTool.FundingAccount,
            to: account,
            quantity: "1.000000005 WIRE",
            memo: WireCollateralTool.FundingMemo
          }
        },
        signal
      )
    })

    it("runFunding rejects a zero amount before transferring", async () => {
      const { ctx } = operatorContext(),
        transfer = jest
          .spyOn(Steps.contracts.sysio.token, "runTransfer")
          .mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runFunding(
          ctx,
          {
            kind: "WireCollateralTool.FundingInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 0n)
          },
          signal
        )
      ).rejects.toThrow(/amount must be positive/)
      expect(transfer).not.toHaveBeenCalled()
    })
  })

  describe("planDeposit", () => {
    it("composes the funding Step and the bond Step, in that order", () => {
      const amount = collateral(WireCode, WireCode, OneWire),
        steps = WireCollateralTool.planDeposit(
          Report.Actor.Underwriter,
          "uwa-bond",
          "bond uwa",
          {},
          OperatorLabel,
          amount
        )
      expect(steps.map(step => step.name)).toEqual([
        `uwa-bond${WireCollateralTool.FundingStepSuffix}`,
        "uwa-bond"
      ])
      expect(steps.map(step => step.runner)).toEqual([
        WireCollateralTool.runFunding,
        WireCollateralTool.runDeposit
      ])
      expect(steps[1].input).toEqual({
        kind: "WireCollateralTool.DepositInput",
        operatorLabel: OperatorLabel,
        collateral: amount
      })
      expect(steps.every(step => step.actor === Report.Actor.Underwriter)).toBe(true)
    })

    it("refuses collateral keyed on an outpost chain", () => {
      expect(() =>
        WireCollateralTool.planDeposit(
          Report.Actor.Underwriter,
          "uwa-bond",
          "bond uwa",
          {},
          OperatorLabel,
          collateral(EthereumChainCode, WireCode, OneWire)
        )
      ).toThrow(/keyed on the WIRE chain, got ETHEREUM/)
    })

    it("runDeposit bonds through opreg::deposit as the operator's on-chain account", async () => {
      const { ctx, account } = operatorContext(),
        deposit = jest
          .spyOn(Steps.contracts.sysio.opreg, "runDeposit")
          .mockResolvedValue(undefined)
      await WireCollateralTool.runDeposit(
        ctx,
        {
          kind: "WireCollateralTool.DepositInput",
          operatorLabel: OperatorLabel,
          collateral: collateral(WireCode, WireCode, OneWire)
        },
        signal
      )
      expect(deposit).toHaveBeenCalledWith(
        ctx,
        {
          kind: "OpregContractSteps.DepositInput",
          data: { account, token_code: "WIRE", amount: "1000000000" }
        },
        signal
      )
    })

    it("runDeposit fails for an operator the key store does not hold", async () => {
      const ctx = fixtureContext(),
        deposit = jest
          .spyOn(Steps.contracts.sysio.opreg, "runDeposit")
          .mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runDeposit(
          ctx,
          {
            kind: "WireCollateralTool.DepositInput",
            operatorLabel: "nobody",
            collateral: collateral(WireCode, WireCode, OneWire)
          },
          signal
        )
      ).rejects.toThrow(/nobody/)
      expect(deposit).not.toHaveBeenCalled()
    })
  })

  describe("planWithdrawal", () => {
    it("captures the typed input and binds runWithdrawal", () => {
      const amount = collateral(WireCode, WireCode, OneWire),
        step = WireCollateralTool.planWithdrawal(
          Report.Actor.Underwriter,
          "uwa-withdraw",
          "withdraw uwa's bond",
          {},
          OperatorLabel,
          amount
        )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.WithdrawInput",
        operatorLabel: OperatorLabel,
        collateral: amount
      })
      expect(step.runner).toBe(WireCollateralTool.runWithdrawal)
    })

    it("runWithdrawal queues the withdrawal through opreg::withdraw", async () => {
      const { ctx, account } = operatorContext()
      serveWithdrawQueue(ctx, [], [withdrawRequest(7, account, "LIQETH", 42n)])
      const withdraw = jest
          .spyOn(Steps.contracts.sysio.opreg, "runWithdraw")
          .mockResolvedValue(undefined)
      await WireCollateralTool.runWithdrawal(
        ctx,
        {
          kind: "WireCollateralTool.WithdrawInput",
          operatorLabel: OperatorLabel,
          collateral: collateral(WireCode, LiqEthCode, 42n)
        },
        signal
      )
      expect(withdraw).toHaveBeenCalledWith(
        ctx,
        {
          kind: "OpregContractSteps.WithdrawInput",
          data: { account, token_code: "LIQETH", amount: "42" }
        },
        signal
      )
    })

    it("runWithdrawal fails with the contract's logged reason when no queue row appears", async () => {
      const { ctx, account } = operatorContext()
      serveWithdrawQueue(ctx, [], [])
      serveOperators(ctx, [
        operatorRow(
          account,
          [balanceEntry("WIRE", "WIRE", 1n)],
          [refusedWithdrawLog("insufficient available balance for withdraw")]
        )
      ])
      jest.spyOn(Steps.contracts.sysio.opreg, "runWithdraw").mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runWithdrawal(
          ctx,
          {
            kind: "WireCollateralTool.WithdrawInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 42n)
          },
          signal
        )
      ).rejects.toThrow(
        `sysio.opreg refused ${account}'s withdrawal of 42 WIRE — no new wtdwqueue row; ` +
          "contract reason: insufficient available balance for withdraw"
      )
    })

    it("runWithdrawal keeps the refusal when the reason read itself fails", async () => {
      const { ctx, account } = operatorContext()
      serveWithdrawQueue(ctx, [], [])
      const contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(contract.tables.operators, "query").mockRejectedValue(new Error("rpc unavailable"))
      jest.spyOn(Steps.contracts.sysio.opreg, "runWithdraw").mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runWithdrawal(
          ctx,
          {
            kind: "WireCollateralTool.WithdrawInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 42n)
          },
          signal
        )
      ).rejects.toThrow(
        `sysio.opreg refused ${account}'s withdrawal of 42 WIRE — no new wtdwqueue row; ` +
          WireCollateralTool.UnreadableRefusalReason
      )
    })

    it("readRefusalReason logs a failed read and answers with the unreadable-reason text", async () => {
      const { ctx, account } = operatorContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg),
        logged = jest.spyOn(Logger.prototype, "log")
      jest.spyOn(contract.tables.operators, "query").mockRejectedValue(new Error("rpc unavailable"))
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await expect(WireCollateralTool.readRefusalReason(ctx, account)).resolves.toBe(
        WireCollateralTool.UnreadableRefusalReason
      )
      expect(logged).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(new RegExp(`${account}'s refusal reason failed: rpc unavailable`))
      )
    })

    it("readRefusalReason reads the newest failed action's message", async () => {
      const { ctx, account } = operatorContext()
      serveOperators(ctx, [operatorRow(account, [], [refusedWithdrawLog("bucket busy")])])
      await expect(WireCollateralTool.readRefusalReason(ctx, account)).resolves.toBe(
        "contract reason: bucket busy"
      )
    })

    it("runWithdrawal does not count a request that was already queued before the push", async () => {
      const { ctx, account } = operatorContext(),
        outstanding = withdrawRequest(3, account, "WIRE", 42n)
      serveWithdrawQueue(ctx, [outstanding], [outstanding])
      serveOperators(ctx, [operatorRow(account, [])])
      jest.spyOn(Steps.contracts.sysio.opreg, "runWithdraw").mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runWithdrawal(
          ctx,
          {
            kind: "WireCollateralTool.WithdrawInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 42n)
          },
          signal
        )
      ).rejects.toThrow(WireCollateralTool.UnreadableRefusalReason)
    })

    it("runWithdrawal refuses a truncated wtdwqueue read", async () => {
      const { ctx } = operatorContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(contract.tables.wtdwqueue, "query").mockResolvedValue({ rows: [], more: true })
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      const withdraw = jest
        .spyOn(Steps.contracts.sysio.opreg, "runWithdraw")
        .mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runWithdrawal(
          ctx,
          {
            kind: "WireCollateralTool.WithdrawInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 42n)
          },
          signal
        )
      ).rejects.toThrow(/wtdwqueue has more than 100 rows; the read is truncated/)
      expect(withdraw).not.toHaveBeenCalled()
    })

    it("runWithdrawal rejects a zero amount before pushing", async () => {
      const { ctx } = operatorContext(),
        withdraw = jest
          .spyOn(Steps.contracts.sysio.opreg, "runWithdraw")
          .mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runWithdrawal(
          ctx,
          {
            kind: "WireCollateralTool.WithdrawInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, 0n)
          },
          signal
        )
      ).rejects.toThrow(/amount must be positive/)
      expect(withdraw).not.toHaveBeenCalled()
    })
  })

  describe("planClaimremit", () => {
    it("captures the typed input and binds runClaimremit", () => {
      const step = WireCollateralTool.planClaimremit(
        Report.Actor.Underwriter,
        "uwa-claim",
        "claim uwa's WIRE",
        {},
        OperatorLabel,
        BigInt(WireCode)
      )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.ClaimremitInput",
        operatorLabel: OperatorLabel,
        tokenCode: BigInt(WireCode)
      })
      expect(step.runner).toBe(WireCollateralTool.runClaimremit)
    })

    it("runClaimremit claims through opreg::claimremit as the operator", async () => {
      const { ctx, account } = operatorContext(),
        claim = jest
          .spyOn(Steps.contracts.sysio.opreg, "runClaimremit")
          .mockResolvedValue(undefined)
      await WireCollateralTool.runClaimremit(
        ctx,
        {
          kind: "WireCollateralTool.ClaimremitInput",
          operatorLabel: OperatorLabel,
          tokenCode: BigInt(WireCode)
        },
        signal
      )
      expect(claim).toHaveBeenCalledWith(
        ctx,
        {
          kind: "OpregContractSteps.ClaimremitInput",
          data: { account, token_code: "WIRE" }
        },
        signal
      )
    })

    it("runClaimremit propagates a rejected push", async () => {
      const { ctx } = operatorContext()
      jest
        .spyOn(Steps.contracts.sysio.opreg, "runClaimremit")
        .mockRejectedValue(new Error("no remit claim for this token"))
      await expect(
        WireCollateralTool.runClaimremit(
          ctx,
          {
            kind: "WireCollateralTool.ClaimremitInput",
            operatorLabel: OperatorLabel,
            tokenCode: BigInt(WireCode)
          },
          signal
        )
      ).rejects.toThrow(/no remit claim for this token/)
    })

    it("runClaimremit fails for an unprovisioned operator", async () => {
      const ctx = fixtureContext(),
        claim = jest
          .spyOn(Steps.contracts.sysio.opreg, "runClaimremit")
          .mockResolvedValue(undefined)
      await expect(
        WireCollateralTool.runClaimremit(
          ctx,
          {
            kind: "WireCollateralTool.ClaimremitInput",
            operatorLabel: "nobody",
            tokenCode: BigInt(WireCode)
          },
          signal
        )
      ).rejects.toThrow(/nobody/)
      expect(claim).not.toHaveBeenCalled()
    })
  })

  describe("planRecordWireBalance / planVerifyWireBalanceIncrease", () => {
    it("planRecordWireBalance captures the operator handle and binds runRecordWireBalance", () => {
      const step = WireCollateralTool.planRecordWireBalance(
        Report.Actor.Underwriter,
        "uwa-record-wire",
        "record uwa's liquid WIRE",
        {},
        OperatorLabel
      )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.RecordWireBalanceInput",
        operatorLabel: OperatorLabel
      })
      expect(step.runner).toBe(WireCollateralTool.runRecordWireBalance)
    })

    it("runRecordWireBalance stores the ON-CHAIN account's liquid WIRE under the label's key", async () => {
      const { ctx, account } = operatorContext(),
        balance = jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(3n * OneWire)
      await WireCollateralTool.runRecordWireBalance(
        ctx,
        { kind: "WireCollateralTool.RecordWireBalanceInput", operatorLabel: OperatorLabel },
        signal
      )
      expect(balance).toHaveBeenCalledWith(account)
      expect(ctx.outputs.get(WireCollateralTool.wireBalanceKey(OperatorLabel))).toBe(3n * OneWire)
    })

    it("runRecordWireBalance fails for an unprovisioned operator without reading", async () => {
      const ctx = fixtureContext(),
        balance = jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(0n)
      await expect(
        WireCollateralTool.runRecordWireBalance(
          ctx,
          { kind: "WireCollateralTool.RecordWireBalanceInput", operatorLabel: "nobody" },
          signal
        )
      ).rejects.toThrow(/nobody/)
      expect(balance).not.toHaveBeenCalled()
    })

    it("wireBalanceKey is distinct per operator label", () => {
      expect(WireCollateralTool.wireBalanceKey("uwa").name).toBe(
        `${WireCollateralTool.WireBalanceKeyPrefix}uwa`
      )
      expect(WireCollateralTool.wireBalanceKey("uwa").name).not.toBe(
        WireCollateralTool.wireBalanceKey("uwb").name
      )
    })

    it("planVerifyWireBalanceIncrease captures the typed input and binds its runner", () => {
      const step = WireCollateralTool.planVerifyWireBalanceIncrease(
        Report.Actor.Underwriter,
        "uwa-claim-paid",
        "the claim paid uwa one WIRE",
        {},
        OperatorLabel,
        OneWire
      )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput",
        operatorLabel: OperatorLabel,
        increase: OneWire
      })
      expect(step.runner).toBe(WireCollateralTool.runVerifyWireBalanceIncrease)
    })

    it("runVerifyWireBalanceIncrease passes when the balance rose by exactly the payout", async () => {
      const { ctx } = operatorContext()
      ctx.outputs.set(WireCollateralTool.wireBalanceKey(OperatorLabel), 2n * OneWire)
      jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(3n * OneWire)
      await expect(
        WireCollateralTool.runVerifyWireBalanceIncrease(
          ctx,
          {
            kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput",
            operatorLabel: OperatorLabel,
            increase: OneWire
          },
          signal
        )
      ).resolves.toBeUndefined()
    })

    it("runVerifyWireBalanceIncrease fails when the payout differs, naming both amounts", async () => {
      const { ctx, account } = operatorContext()
      ctx.outputs.set(WireCollateralTool.wireBalanceKey(OperatorLabel), 2n * OneWire)
      jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(2n * OneWire)
      await expect(
        WireCollateralTool.runVerifyWireBalanceIncrease(
          ctx,
          {
            kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput",
            operatorLabel: OperatorLabel,
            increase: OneWire
          },
          signal
        )
      ).rejects.toThrow(new RegExp(`${account}'s liquid WIRE rose by 0, expected ${OneWire}`))
    })

    it("runVerifyWireBalanceIncrease fails when no balance was recorded first", async () => {
      const { ctx } = operatorContext(),
        balance = jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(OneWire)
      await expect(
        WireCollateralTool.runVerifyWireBalanceIncrease(
          ctx,
          {
            kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput",
            operatorLabel: OperatorLabel,
            increase: OneWire
          },
          signal
        )
      ).rejects.toThrow(/WireCollateralTool\.wireBalance\.uwa/)
      expect(balance).not.toHaveBeenCalled()
    })
  })

  describe("planVerifyBalanceRow", () => {
    it("captures the typed input and binds runVerifyBalanceRow", () => {
      const amount = collateral(WireCode, WireCode, OneWire),
        step = WireCollateralTool.planVerifyBalanceRow(
          Report.Actor.Sysio,
          "uwa-bonded",
          "uwa's WIRE row holds the bond",
          {},
          OperatorLabel,
          amount
        )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.VerifyBalanceRowInput",
        operatorLabel: OperatorLabel,
        collateral: amount
      })
      expect(step.runner).toBe(WireCollateralTool.runVerifyBalanceRow)
    })

    it("refuses an outpost-chain row at plan time", () => {
      expect(() =>
        WireCollateralTool.planVerifyBalanceRow(
          Report.Actor.Sysio,
          "uwa-bonded",
          "d",
          {},
          OperatorLabel,
          collateral(EthereumChainCode, WireCode, OneWire)
        )
      ).toThrow(/keyed on the WIRE chain/)
    })

    it("passes when the (WIRE, token) row holds exactly the expected balance", async () => {
      const { ctx, account } = operatorContext()
      serveOperators(ctx, [
        operatorRow(account, [
          balanceEntry("ETHEREUM", "WIRE", 7n),
          balanceEntry("WIRE", "WIRE", OneWire)
        ])
      ])
      await expect(
        WireCollateralTool.runVerifyBalanceRow(
          ctx,
          {
            kind: "WireCollateralTool.VerifyBalanceRowInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, OneWire)
          },
          signal
        )
      ).resolves.toBeUndefined()
    })

    it("fails when the balance differs, naming the account and both amounts", async () => {
      const { ctx, account } = operatorContext()
      serveOperators(ctx, [operatorRow(account, [balanceEntry("WIRE", "WIRE", 5n)])])
      await expect(
        WireCollateralTool.runVerifyBalanceRow(
          ctx,
          {
            kind: "WireCollateralTool.VerifyBalanceRowInput",
            operatorLabel: OperatorLabel,
            collateral: collateral(WireCode, WireCode, OneWire)
          },
          signal
        )
      ).rejects.toThrow(`${account} (WIRE, WIRE) balance is 5, expected ${OneWire}`)
    })

    it("readBalance refuses a truncated operators read instead of reading zero", async () => {
      const { ctx, account } = operatorContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(contract.tables.operators, "query").mockResolvedValue({ rows: [], more: true })
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await expect(
        WireCollateralTool.readBalance(ctx, account, BigInt(WireCode))
      ).rejects.toThrow(/operators has more than 100 rows; the read is truncated/)
    })

    it("readOperatorRow reads the row of the operator's ON-CHAIN account, by label", async () => {
      const { ctx, account } = operatorContext(),
        row = operatorRow(account, [balanceEntry("WIRE", "WIRE", OneWire)])
      serveOperators(ctx, [operatorRow("someoneelse", []), row])
      await expect(WireCollateralTool.readOperatorRow(ctx, OperatorLabel)).resolves.toEqual(row)
    })

    it("readOperatorRow refuses a truncated operators read", async () => {
      const { ctx, account } = operatorContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest
        .spyOn(contract.tables.operators, "query")
        .mockResolvedValue({ rows: [operatorRow(account, [])], more: true })
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await expect(WireCollateralTool.readOperatorRow(ctx, OperatorLabel)).rejects.toThrow(
        /operators has more than/
      )
    })

    it("readOperatorRow fails for an unprovisioned label and answers absent for an unregistered account", async () => {
      const { ctx } = operatorContext()
      serveOperators(ctx, [])
      await expect(WireCollateralTool.readOperatorRow(ctx, "nobody")).rejects.toThrow(/nobody/)
      await expect(WireCollateralTool.readOperatorRow(ctx, OperatorLabel)).resolves.toBeUndefined()
    })

    it("readBalance reads a missing operator or row as zero", async () => {
      const { ctx, account } = operatorContext()
      serveOperators(ctx, [operatorRow(account, [balanceEntry("WIRE", "WIRE", OneWire)])])
      await expect(
        WireCollateralTool.readBalance(ctx, account, BigInt(LiqEthCode))
      ).resolves.toBe(0n)
      await expect(
        WireCollateralTool.readBalance(ctx, "acct.other", BigInt(WireCode))
      ).resolves.toBe(0n)
    })
  })

  describe("planVerifyRemitClaim", () => {
    const claim = TokenAmount.create({ tokenCode: BigInt(WireCode), amount: OneWire })

    it("captures the typed input and binds runVerifyRemitClaim", () => {
      const step = WireCollateralTool.planVerifyRemitClaim(
        Report.Actor.Sysio,
        "uwa-claim-credited",
        "uwa's WIRE claim holds the withdrawal",
        {},
        OperatorLabel,
        claim
      )
      expect(step.input).toEqual({
        kind: "WireCollateralTool.VerifyRemitClaimInput",
        operatorLabel: OperatorLabel,
        claim
      })
      expect(step.runner).toBe(WireCollateralTool.runVerifyRemitClaim)
    })

    it("passes as soon as the operator's claim holds the expected balance", async () => {
      const { ctx, account } = operatorContext()
      serveRemitClaims(ctx, [
        { account: "someone.else", token_code: "WIRE", balance: "1" },
        { account, token_code: "LIQETH", balance: "3" },
        { account, token_code: "WIRE", balance: OneWire.toString() }
      ])
      await expect(
        WireCollateralTool.runVerifyRemitClaim(
          ctx,
          {
            kind: "WireCollateralTool.VerifyRemitClaimInput",
            operatorLabel: OperatorLabel,
            claim
          },
          signal
        )
      ).resolves.toBeUndefined()
    })

    it("times out after the epoch-derived deadline when the claim never matches", async () => {
      jest.useFakeTimers()
      const { ctx, account } = operatorContext()
      serveRemitClaims(ctx, [
        { account, token_code: "WIRE", balance: "1" }
      ])
      const deadlineMs = WireCollateralTool.remitClaimDeadlineMs(ctx.config),
        verified = WireCollateralTool.runVerifyRemitClaim(
          ctx,
          {
            kind: "WireCollateralTool.VerifyRemitClaimInput",
            operatorLabel: OperatorLabel,
            claim
          },
          signal
        ),
        outcome = expect(verified).rejects.toThrow(/Timed out waiting for: .*remitclaims\(WIRE\)/)
      await jest.advanceTimersByTimeAsync(
        deadlineMs + WireCollateralTool.RemitClaimPollIntervalMs
      )
      await outcome
    })

    it("readRemitClaim reads a missing row as zero", async () => {
      const { ctx, account } = operatorContext()
      serveRemitClaims(ctx, [
        { account, token_code: "LIQETH", balance: "3" }
      ])
      await expect(
        WireCollateralTool.readRemitClaim(ctx, account, BigInt(WireCode))
      ).resolves.toBe(0n)
    })

    it("readRemitClaim refuses a truncated remitclaims read instead of reading zero", async () => {
      const { ctx, account } = operatorContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(contract.tables.remitclaims, "query").mockResolvedValue({ rows: [], more: true })
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await expect(
        WireCollateralTool.readRemitClaim(ctx, account, BigInt(WireCode))
      ).rejects.toThrow(/remitclaims has more than 100 rows; the read is truncated/)
    })

    /** A resolved config with only the clock durations varied: every chain at `epochDurationSec`. */
    function clocks(epochDurationSec: number, economicEpochDurationSec: number) {
      return {
        ...fixtureContext().config,
        epochDurationSec,
        outpostEpochDurationSec: createUniformOutpostEpochDurations(epochDurationSec),
        economicEpochDurationSec
      }
    }

    it("remitClaimDeadlineMs waits on the slowest outpost chain's consensus", () => {
      const perChain = {
        ...clocks(60, 60),
        outpostEpochDurationSec: {
          ...createUniformOutpostEpochDurations(60),
          [Constants.SOLANA_CHAIN_CODENAME]: 300
        }
      }
      expect(WireCollateralTool.remitClaimDeadlineMs(perChain)).toBe(
        WireCollateralTool.RemitClaimEpochCount * 330_000
      )
    })

    it("remitClaimDeadlineMs spans RemitClaimEpochCount effective epochs of the slower clock", () => {
      expect(WireCollateralTool.remitClaimDeadlineMs(clocks(60, 60))).toBe(
        WireCollateralTool.RemitClaimEpochCount * 90_000
      )
      // Either clock can be the slower one: the withdrawal waits on both.
      expect(WireCollateralTool.remitClaimDeadlineMs(clocks(60, 300))).toBe(
        WireCollateralTool.RemitClaimEpochCount * 330_000
      )
      expect(WireCollateralTool.remitClaimDeadlineMs(clocks(300, 60))).toBe(
        WireCollateralTool.RemitClaimEpochCount * 330_000
      )
    })

    it("remitClaimStepTimeoutMs sits one poll buffer above the poll deadline for the same config", () => {
      expect(WireCollateralTool.remitClaimStepTimeoutMs(clocks(60, 60))).toBe(
        WireCollateralTool.remitClaimDeadlineMs(clocks(60, 60)) + ProtocolTiming.PollDeadlineBufferMs
      )
      expect(WireCollateralTool.remitClaimStepTimeoutMs(clocks(60, 120))).toBeGreaterThan(
        WireCollateralTool.remitClaimStepTimeoutMs(clocks(60, 60))
      )
    })

    /** The instant the economic-start tests measure from. */
    const PlannedAtMs = Date.UTC(2026, 10, 20, 12, 0, 0),
      TenMinutesMs = 10 * 60_000

    /** A config of 60 s clocks whose economic epoch 1 opens at `startMs`. */
    function startingAt(startMs: number) {
      return {
        ...clocks(60, 60),
        economicStartTime: WireClient.toChainSeconds(new Date(startMs).toISOString())
      }
    }

    it("economicStartDelayMs is the time left until a future economic start", () => {
      expect(
        WireCollateralTool.economicStartDelayMs(
          startingAt(PlannedAtMs + TenMinutesMs).economicStartTime,
          PlannedAtMs
        )
      ).toBe(TenMinutesMs)
    })

    it("economicStartDelayMs adds nothing for a past start or one anchored at the chain head", () => {
      expect(
        WireCollateralTool.economicStartDelayMs(
          startingAt(PlannedAtMs - TenMinutesMs).economicStartTime,
          PlannedAtMs
        )
      ).toBe(0)
      expect(
        WireCollateralTool.economicStartDelayMs(
          startingAt(PlannedAtMs).economicStartTime,
          PlannedAtMs
        )
      ).toBe(0)
      expect(WireCollateralTool.economicStartDelayMs(null, PlannedAtMs)).toBe(0)
    })

    it("remitClaimDeadlineMs waits for a future first economic tick before counting epochs", () => {
      const epochsMs = WireCollateralTool.remitClaimDeadlineMs(clocks(60, 60), PlannedAtMs)
      // 60 s clocks: six minutes of epochs, which a withdrawal queued ten minutes before the
      // start waits for only after those ten.
      expect(epochsMs).toBe(6 * 60_000)
      expect(
        WireCollateralTool.remitClaimDeadlineMs(startingAt(PlannedAtMs + TenMinutesMs), PlannedAtMs)
      ).toBe(TenMinutesMs + epochsMs)
      expect(
        WireCollateralTool.remitClaimDeadlineMs(startingAt(PlannedAtMs - TenMinutesMs), PlannedAtMs)
      ).toBe(epochsMs)
    })

    it("remitClaimStepTimeoutMs carries the same lead, so the Step never races its poll", () => {
      const config = startingAt(PlannedAtMs + TenMinutesMs)
      expect(WireCollateralTool.remitClaimStepTimeoutMs(config, PlannedAtMs)).toBe(
        WireCollateralTool.remitClaimDeadlineMs(config, PlannedAtMs) +
          ProtocolTiming.PollDeadlineBufferMs
      )
      // Planned before the runner starts, the ceiling's lead is never the shorter one.
      expect(WireCollateralTool.remitClaimStepTimeoutMs(config, PlannedAtMs)).toBeGreaterThan(
        WireCollateralTool.remitClaimDeadlineMs(config, PlannedAtMs + 60_000)
      )
    })

    it("keeps polling past the epoch budget while the economic clock has not started", async () => {
      jest.useFakeTimers()
      const { ctx, account } = operatorContext(startingAt(Date.now() + TenMinutesMs))
      serveRemitClaims(ctx, [{ account, token_code: "WIRE", balance: "1" }])
      const leadMs = WireCollateralTool.economicStartDelayMs(ctx.config.economicStartTime, Date.now()),
        epochsMs = WireCollateralTool.remitClaimDeadlineMs(clocks(60, 60), Date.now()),
        rejection = jest.fn(),
        verified = WireCollateralTool.runVerifyRemitClaim(
          ctx,
          { kind: "WireCollateralTool.VerifyRemitClaimInput", operatorLabel: OperatorLabel, claim },
          signal
        ).catch(rejection)
      // The six-minute epoch budget alone has passed: still waiting on the first tick.
      await jest.advanceTimersByTimeAsync(epochsMs + WireCollateralTool.RemitClaimPollIntervalMs)
      expect(rejection).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(leadMs)
      await verified
      expect(rejection).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/Timed out waiting for: .*remitclaims\(WIRE\)/)
        })
      )
    })
  })

  describe("value helpers", () => {
    it("tokenSpelling renders a packed code as its slug spelling", () => {
      expect(WireCollateralTool.tokenSpelling(BigInt(LiqEthCode))).toBe("LIQETH")
    })

    it("createWireCollateral keys the amount on (WIRE, WIRE)", () => {
      expect(WireCollateralTool.createWireCollateral(2n * OneWire)).toEqual(
        collateral(WireCode, WireCode, 2n * OneWire)
      )
      expect(() =>
        WireCollateralTool.assertWireCollateral(WireCollateralTool.createWireCollateral(OneWire))
      ).not.toThrow()
    })

    it("createWireCollateral keys a zero amount on (WIRE, WIRE) too — the value a drained row verifies against", () => {
      const zero = WireCollateralTool.createWireCollateral(0n)
      expect(zero.chain_code).toBe(WireCode)
      expect(zero.amount.tokenCode).toBe(BigInt(WireCode))
      expect(zero.amount.amount).toBe(0n)
    })

    it("WireTokenCode is the WIRE slug as a bigint", () => {
      expect(WireCollateralTool.WireTokenCode).toBe(BigInt(WireCode))
    })

    it("createWireClaim keys the amount on the WIRE token, zero included", () => {
      expect(WireCollateralTool.createWireClaim(OneWire)).toEqual(
        TokenAmount.create({ tokenCode: BigInt(WireCode), amount: OneWire })
      )
      expect(WireCollateralTool.createWireClaim(0n).amount).toBe(0n)
      expect(WireCollateralTool.createWireCollateral(OneWire).amount).toEqual(
        WireCollateralTool.createWireClaim(OneWire)
      )
    })

    it("createWireRequirement builds the (WIRE, WIRE) minimum", () => {
      expect(WireCollateralTool.createWireRequirement(OneWire)).toEqual({
        chainCode: WireCode,
        tokenCode: WireCode,
        minimumBond: Number(OneWire)
      })
    })

    it("createWireRequirement refuses a zero minimum and one past the exact number range", () => {
      expect(() => WireCollateralTool.createWireRequirement(0n)).toThrow(/must be positive/)
      expect(() =>
        WireCollateralTool.createWireRequirement(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
      ).toThrow(/must be positive and at most/)
    })

    it("assertWireCollateral accepts (WIRE, WIRE) and refuses an outpost chain", () => {
      expect(() =>
        WireCollateralTool.assertWireCollateral(collateral(WireCode, WireCode, OneWire))
      ).not.toThrow()
      expect(() =>
        WireCollateralTool.assertWireCollateral(collateral(EthereumChainCode, WireCode, OneWire))
      ).toThrow(/keyed on the WIRE chain/)
    })
  })
})

describe("WireCollateralTool consensus waits", () => {
  const request = withdrawRequest(7, "withdrawer", "WIRE", 1n),
    { ETHEREUM_CHAIN_CODENAME: Ethereum, SOLANA_CHAIN_CODENAME: Solana } = Constants,
    waitingOn = (waits: SysioContracts.SysioOpregConsensusWaitType[]) => ({
      ...request,
      consensus_waits: waits
    })

  it("names the outpost chain of each wait, by its slug spelling", () => {
    expect(
      WireCollateralTool.consensusWaitChain({ chain_code: Solana, eligible_at_epoch: 4 })
    ).toBe(Solana)
    expect(() =>
      WireCollateralTool.consensusWaitChain({ chain_code: "WIRE", eligible_at_epoch: 4 })
    ).toThrow(/WIRE, which is not an outpost chain/)
  })

  it("maps each waited-on chain to the epoch it waits for, and leaves the others out", () => {
    expect(
      WireCollateralTool.consensusWaitEpochs(
        waitingOn([{ chain_code: Solana, eligible_at_epoch: 9 }])
      )
    ).toEqual({ [Solana]: 9 })
    expect(WireCollateralTool.consensusWaitEpochs(waitingOn([]))).toEqual({})
  })

  it("passes only once every waited-on chain reached its epoch", () => {
    const both = waitingOn([
      { chain_code: Ethereum, eligible_at_epoch: 5 },
      { chain_code: Solana, eligible_at_epoch: 3 }
    ])
    expect(WireCollateralTool.consensusWaitsPassed(both, { [Ethereum]: 5, [Solana]: 3 })).toBe(true)
    expect(WireCollateralTool.consensusWaitsPassed(both, { [Ethereum]: 4, [Solana]: 9 })).toBe(false)
    // A request that waits on one chain ignores the other chain's index.
    expect(
      WireCollateralTool.consensusWaitsPassed(
        waitingOn([{ chain_code: Solana, eligible_at_epoch: 3 }]),
        { [Ethereum]: 0, [Solana]: 3 }
      )
    ).toBe(true)
    expect(WireCollateralTool.consensusWaitsPassed(waitingOn([]), { [Ethereum]: 0, [Solana]: 0 })).toBe(true)
  })

  it("mirrors sysio.opreg's WITHDRAW_WAIT_EPOCHS", () => {
    expect(WireCollateralTool.WithdrawWaitConsensusEpochs).toBe(2)
  })

  describe("assertConsensusWaits", () => {
    const wait = WireCollateralTool.WithdrawWaitConsensusEpochs,
      before = { [Ethereum]: 10, [Solana]: 4 },
      after = { [Ethereum]: 11, [Solana]: 4 }

    it("accepts a guard per served chain, each the wait past an epoch between the readings", () => {
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([
            { chain_code: Ethereum, eligible_at_epoch: 11 + wait },
            { chain_code: Solana, eligible_at_epoch: 4 + wait }
          ]),
          [Ethereum, Solana],
          before,
          after
        )
      ).not.toThrow()
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([{ chain_code: Solana, eligible_at_epoch: 4 + wait }]),
          [Solana],
          before,
          after
        )
      ).not.toThrow()
    })

    it("refuses a guard counted from an epoch outside the readings", () => {
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([{ chain_code: Ethereum, eligible_at_epoch: 12 + wait }]),
          [Ethereum],
          before,
          after
        )
      ).toThrow(new RegExp(`waits for ${Ethereum} epoch ${12 + wait}, not ${wait} past a ${Ethereum} consensus epoch in 10..11`))
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([{ chain_code: Solana, eligible_at_epoch: 3 + wait }]),
          [Solana],
          before,
          after
        )
      ).toThrow(/in 4..4/)
    })

    it("refuses a request that waits on another set of chains", () => {
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([{ chain_code: Ethereum, eligible_at_epoch: 10 + wait }]),
          [Solana],
          before,
          after
        )
      ).toThrow(new RegExp(`waits on ${Ethereum}, not on ${Solana}`))
      expect(() =>
        WireCollateralTool.assertConsensusWaits(waitingOn([]), [Solana], before, after)
      ).toThrow(new RegExp(`waits on no chain, not on ${Solana}`))
    })

    it("refuses a request that waits on one chain twice", () => {
      expect(() =>
        WireCollateralTool.assertConsensusWaits(
          waitingOn([
            { chain_code: Solana, eligible_at_epoch: 4 + wait },
            { chain_code: Solana, eligible_at_epoch: 4 + wait }
          ]),
          [Solana],
          before,
          after
        )
      ).toThrow(/more than once/)
    })
  })
})

describe("WireCollateralTool.planVerifyOperatorStatus", () => {
  const { OPERATOR_STATUS_ACTIVE, OPERATOR_STATUS_UNKNOWN } = SysioContracts.SysioOpregOperatorstatus

  afterEach(() => jest.restoreAllMocks())

  it("carries the operator handle and the status to its named runner", () => {
    const step = WireCollateralTool.planVerifyOperatorStatus(
      Report.Actor.Underwriter,
      "status",
      "status",
      {},
      OperatorLabel,
      OPERATOR_STATUS_ACTIVE
    )
    expect(step.input).toEqual({
      kind: "WireCollateralTool.VerifyOperatorStatusInput",
      operatorLabel: OperatorLabel,
      status: OPERATOR_STATUS_ACTIVE
    })
    expect(step.runner).toBe(WireCollateralTool.runVerifyOperatorStatus)
  })

  it("passes when the operator's row carries the status, by value or by ABI spelling", async () => {
    const { ctx, account } = operatorContext(),
      step = WireCollateralTool.planVerifyOperatorStatus(
        Report.Actor.Underwriter,
        "status",
        "status",
        {},
        OperatorLabel,
        OPERATOR_STATUS_ACTIVE
      )
    serveOperators(ctx, [operatorRow(account, [])])
    await expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
    serveOperators(ctx, [{ ...operatorRow(account, []), status: "OPERATOR_STATUS_ACTIVE" }])
    await expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
  })

  it("fails naming the operator, its status and the expected one when they differ", async () => {
    const { ctx, account } = operatorContext(),
      step = WireCollateralTool.planVerifyOperatorStatus(
        Report.Actor.Underwriter,
        "status",
        "status",
        {},
        OperatorLabel,
        OPERATOR_STATUS_UNKNOWN
      )
    serveOperators(ctx, [operatorRow(account, [])])
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      new RegExp(`${OperatorLabel} is .*, not OPERATOR_STATUS_UNKNOWN`)
    )
  })

  it("fails for an operator with no operators row", async () => {
    const { ctx } = operatorContext(),
      step = WireCollateralTool.planVerifyOperatorStatus(
        Report.Actor.Underwriter,
        "status",
        "status",
        {},
        OperatorLabel,
        OPERATOR_STATUS_ACTIVE
      )
    serveOperators(ctx, [operatorRow("someoneelse", [])])
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      new RegExp(`${OperatorLabel} has no sysio.opreg::operators row`)
    )
  })
})
