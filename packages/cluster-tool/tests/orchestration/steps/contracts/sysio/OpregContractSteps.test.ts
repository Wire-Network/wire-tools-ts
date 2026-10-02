import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

describe("Steps.contracts.sysio.opreg", () => {
  it("setconfig carries the opreg::setconfig data", () => {
    const data: SysioContracts.SysioOpregSetconfigAction = {
      max_available_producers: 21,
      max_available_batch_ops: 63,
      max_available_underwriters: 21,
      terminate_prune_delay_ms: 600_000,
      terminate_max_consecutive_misses: 5,
      terminate_max_pct_misses_24h: 5,
      terminate_window_ms: 86_400_000,
      req_prod_collat: [],
      req_batchop_collat: [],
      req_uw_collat: []
    }
    const step = Steps.contracts.sysio.opreg.planSetconfig(
      Report.Actor.Sysio,
      "configure-opreg",
      "set the operator-registry config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("OpregContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.max_available_batch_ops).toBe(63)
    expect(typeof step.runner).toBe("function")
  })

  it("regoperator carries the opreg::regoperator data", () => {
    const data: SysioContracts.SysioOpregRegoperatorAction = {
      account: "batchop.a",
      type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
      is_bootstrapped: true
    }
    const step = Steps.contracts.sysio.opreg.planRegoperator(
      Report.Actor.BatchOperator,
      "register-batchop-a",
      "register batchop.a as a bootstrapped batch operator",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.BatchOperator)
    expect(step.input.kind).toBe("OpregContractSteps.RegoperatorInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.is_bootstrapped).toBe(true)
    expect(typeof step.runner).toBe("function")
  })

  describe("depot-native collateral actions", () => {
    const operatorAccount = "nodeowner.uwa",
      operatorAuthorization = {
        authorization: [{ actor: operatorAccount, permission: "active" }]
      },
      signal = new AbortController().signal

    /** A fixture context whose opreg client is the one the spies are installed on. */
    function opregContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, contract }
    }

    afterEach(() => jest.restoreAllMocks())

    it("deposit carries the opreg::deposit data and binds runDeposit", () => {
      const data: SysioContracts.SysioOpregDepositAction = {
        account: operatorAccount,
        token_code: "WIRE",
        amount: "1000000000"
      }
      const step = Steps.contracts.sysio.opreg.planDeposit(
        Report.Actor.Underwriter,
        "bond-uwa",
        "bond uwa's WIRE on the depot",
        {},
        data
      )
      expect(step.actor).toBe(Report.Actor.Underwriter)
      expect(step.input).toEqual({ kind: "OpregContractSteps.DepositInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runDeposit)
    })

    it("runDeposit signs as the depositing operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.deposit, "invoke").mockResolvedValue(undefined),
        data: SysioContracts.SysioOpregDepositAction = {
          account: operatorAccount,
          token_code: "WIRE",
          amount: "1000000000"
        }
      await Steps.contracts.sysio.opreg.runDeposit(
        ctx,
        { kind: "OpregContractSteps.DepositInput", data },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(data, operatorAuthorization)
    })

    it("runDeposit pushes nothing once the step is aborted", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.deposit, "invoke").mockResolvedValue(undefined),
        controller = new AbortController()
      controller.abort()
      await expect(
        Steps.contracts.sysio.opreg.runDeposit(
          ctx,
          {
            kind: "OpregContractSteps.DepositInput",
            data: { account: operatorAccount, token_code: "WIRE", amount: "1" }
          },
          controller.signal
        )
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })

    it("withdraw carries the opreg::withdraw data and binds runWithdraw", () => {
      const data: SysioContracts.SysioOpregWithdrawAction = {
        account: operatorAccount,
        token_code: "WIRE",
        amount: "250000000"
      }
      const step = Steps.contracts.sysio.opreg.planWithdraw(
        Report.Actor.Underwriter,
        "withdraw-uwa",
        "queue a withdrawal of uwa's WIRE",
        {},
        data
      )
      expect(step.input).toEqual({ kind: "OpregContractSteps.WithdrawInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runWithdraw)
    })

    it("runWithdraw signs as the withdrawing operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.withdraw, "invoke").mockResolvedValue(undefined),
        data: SysioContracts.SysioOpregWithdrawAction = {
          account: operatorAccount,
          token_code: "WIRE",
          amount: "250000000"
        }
      await Steps.contracts.sysio.opreg.runWithdraw(
        ctx,
        { kind: "OpregContractSteps.WithdrawInput", data },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(data, operatorAuthorization)
    })

    it("runWithdraw propagates a rejected push", async () => {
      const { ctx, contract } = opregContext()
      jest
        .spyOn(contract.actions.withdraw, "invoke")
        .mockRejectedValue(new Error("unsupported depot-native collateral token"))
      await expect(
        Steps.contracts.sysio.opreg.runWithdraw(
          ctx,
          {
            kind: "OpregContractSteps.WithdrawInput",
            data: { account: operatorAccount, token_code: "ETH", amount: "1" }
          },
          signal
        )
      ).rejects.toThrow(/unsupported depot-native collateral token/)
    })

    it("claimremit carries the opreg::claimremit data and binds runClaimremit", () => {
      const data: SysioContracts.SysioOpregClaimremitAction = {
        account: operatorAccount,
        token_code: "WIRE"
      }
      const step = Steps.contracts.sysio.opreg.planClaimremit(
        Report.Actor.Underwriter,
        "claim-uwa",
        "pay uwa's WIRE remit claim",
        {},
        data
      )
      expect(step.input).toEqual({ kind: "OpregContractSteps.ClaimremitInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runClaimremit)
    })

    it("runClaimremit signs as the claiming operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.claimremit, "invoke").mockResolvedValue(undefined),
        data: SysioContracts.SysioOpregClaimremitAction = {
          account: operatorAccount,
          token_code: "WIRE"
        }
      await Steps.contracts.sysio.opreg.runClaimremit(
        ctx,
        { kind: "OpregContractSteps.ClaimremitInput", data },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(data, operatorAuthorization)
    })

    it("runClaimremit pushes nothing once the step is aborted", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.claimremit, "invoke").mockResolvedValue(undefined),
        controller = new AbortController()
      controller.abort()
      await expect(
        Steps.contracts.sysio.opreg.runClaimremit(
          ctx,
          {
            kind: "OpregContractSteps.ClaimremitInput",
            data: { account: operatorAccount, token_code: "WIRE" }
          },
          controller.signal
        )
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
