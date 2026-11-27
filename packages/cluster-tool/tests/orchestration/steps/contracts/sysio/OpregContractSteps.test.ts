import { SysioContracts } from "@wireio/sdk-core"

import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"
import { fixtureOperatorRow } from "./opregOperatorRowFixture.js"

describe("Steps.contracts.sysio.opreg", () => {
  it("setconfig carries the opreg::setconfig data", () => {
    const data: SysioContracts.SysioOpregSetconfigAction = {
      terminate_prune_delay_ms: 600_000,
      terminate_max_consecutive_misses: 5,
      terminate_max_pct_misses_24h: 5,
      terminate_min_pct_samples: 20,
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
    expect(step.input.data.terminate_window_ms).toBe(86_400_000)
    expect(step.input.data.terminate_min_pct_samples).toBe(20)
    expect(step.runner).toBe(Steps.contracts.sysio.opreg.runSetconfig)
  })

  describe("setconfig runner", () => {
    afterEach(() => jest.restoreAllMocks())

    it("runSetconfig pushes the data whole, the percent-rail sample included", async () => {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg),
        data: SysioContracts.SysioOpregSetconfigAction = {
          terminate_prune_delay_ms: 600_000,
          terminate_max_consecutive_misses: 2,
          terminate_max_pct_misses_24h: 5,
          terminate_min_pct_samples: 2,
          terminate_window_ms: 86_400_000,
          req_prod_collat: [],
          req_batchop_collat: [],
          req_uw_collat: []
        }
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      const invoke = jest
        .spyOn(contract.actions.setconfig, "invoke")
        .mockResolvedValue(undefined)
      await Steps.contracts.sysio.opreg.runSetconfig(
        ctx,
        { kind: "OpregContractSteps.SetconfigInput", data },
        new AbortController().signal
      )
      expect(invoke).toHaveBeenCalledWith(data)
    })

    it("runSetconfig refuses an aborted signal before pushing", async () => {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg),
        aborted = new AbortController()
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      const invoke = jest.spyOn(contract.actions.setconfig, "invoke")
      aborted.abort()
      await expect(
        Steps.contracts.sysio.opreg.runSetconfig(
          ctx,
          {
            kind: "OpregContractSteps.SetconfigInput",
            data: {} as SysioContracts.SysioOpregSetconfigAction
          },
          aborted.signal
        )
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })
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

  describe("chain membership and governance termination actions", () => {
    const operatorAccount = "chainop.a1b2",
      chain = Constants.SOLANA_CHAIN_CODENAME,
      signal = new AbortController().signal

    /** A fixture context whose opreg client is the one the spies are installed on. */
    function opregContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, contract }
    }

    afterEach(() => jest.restoreAllMocks())

    it("planJoinchain carries the operator and its chain, and runJoinchain signs as the operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.joinchain, "invoke").mockResolvedValue(undefined),
        data = { account: operatorAccount, chain_code: chain },
        step = Steps.contracts.sysio.opreg.planJoinchain(
          Report.Actor.BatchOperator,
          "joinchain",
          "joinchain",
          {},
          data
        )
      expect(step.input).toEqual({ kind: "OpregContractSteps.JoinchainInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runJoinchain)
      await step.runner(ctx, step.input, signal)
      expect(invoke).toHaveBeenCalledWith(data, {
        authorization: [{ actor: operatorAccount, permission: "active" }]
      })
    })

    it("planLeavechain carries the operator and its chain, and runLeavechain signs as the operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.leavechain, "invoke").mockResolvedValue(undefined),
        data = { account: operatorAccount, chain_code: chain },
        step = Steps.contracts.sysio.opreg.planLeavechain(
          Report.Actor.BatchOperator,
          "leavechain",
          "leavechain",
          {},
          data
        )
      expect(step.input).toEqual({ kind: "OpregContractSteps.LeavechainInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runLeavechain)
      await step.runner(ctx, step.input, signal)
      expect(invoke).toHaveBeenCalledWith(data, {
        authorization: [{ actor: operatorAccount, permission: "active" }]
      })
    })

    it("an aborted joinchain step pushes nothing", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.joinchain, "invoke").mockResolvedValue(undefined),
        step = Steps.contracts.sysio.opreg.planJoinchain(Report.Actor.BatchOperator, "joinchain", "joinchain", {}, {
          account: operatorAccount,
          chain_code: chain
        })
      await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })

    it("an aborted leavechain step pushes nothing", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.leavechain, "invoke").mockResolvedValue(undefined),
        step = Steps.contracts.sysio.opreg.planLeavechain(Report.Actor.BatchOperator, "leavechain", "leavechain", {}, {
          account: operatorAccount,
          chain_code: chain
        })
      await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })

    it("runJoinchain propagates the contract's refusal", async () => {
      const { ctx, contract } = opregContext()
      jest
        .spyOn(contract.actions.joinchain, "invoke")
        .mockRejectedValue(new Error("operator still holds a seat in the chain's schedule window"))
      await expect(
        Steps.contracts.sysio.opreg.runJoinchain(
          ctx,
          {
            kind: "OpregContractSteps.JoinchainInput",
            data: { account: operatorAccount, chain_code: chain }
          },
          signal
        )
      ).rejects.toThrow(/still holds a seat/)
    })

    it("terminate carries the governance reason and runTerminate signs as the contract", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest.spyOn(contract.actions.terminate, "invoke").mockResolvedValue(undefined),
        data: SysioContracts.SysioOpregTerminateAction = {
          account: operatorAccount,
          reason: "governance termination"
        },
        step = Steps.contracts.sysio.opreg.planTerminate(
          Report.Actor.Sysio,
          "terminate",
          "terminate",
          {},
          data
        )
      expect(step.input).toEqual({ kind: "OpregContractSteps.TerminateInput", data })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runTerminate)
      await Steps.contracts.sysio.opreg.runTerminate(ctx, step.input, signal)
      expect(invoke).toHaveBeenCalledWith(data)
      expect(contract.actions.terminate.prepare(data).authorization).toEqual([
        { actor: SysioContracts.SysioContractAccount[SysioContracts.SysioContractName.opreg], permission: "active" }
      ])
    })
  })

  describe("servchains read", () => {
    /** One `servchains` row of `account` on `chain`. */
    function membershipRow(
      account: string,
      chain: Constants.OutpostChainCodename,
      status: SysioContracts.SysioOpregChainServiceStatus
    ): SysioContracts.SysioOpregServedChainType {
      return {
        account,
        chain_code: chain,
        status,
        joined_at_ms: 1_000,
        updated_at_ms: 2_000,
        status_reason: "",
        tally: { first_log_id: 0, duties: 0, misses: 0, miss_run: 0 }
      }
    }

    /** A fixture context whose `sysio.opreg::servchains` query is stubbable. */
    function servedChainsContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, query: jest.spyOn(contract.tables.servchains, "query") }
    }

    afterEach(() => jest.restoreAllMocks())

    it("readServedChains returns every row of one complete read at ServedChainReadLimit", async () => {
      const { ctx, query } = servedChainsContext(),
        rows = [
          membershipRow("chainop.a", Constants.ETHEREUM_CHAIN_CODENAME, SysioContracts.SysioOpregChainServiceStatus.SERVING),
          membershipRow("chainop.a", Constants.SOLANA_CHAIN_CODENAME, SysioContracts.SysioOpregChainServiceStatus.LEFT)
        ]
      query.mockResolvedValue({ rows, more: false })
      await expect(Steps.contracts.sysio.opreg.readServedChains(ctx)).resolves.toEqual(rows)
      expect(query).toHaveBeenCalledWith({
        limit: Steps.contracts.sysio.opreg.ServedChainReadLimit
      })
    })

    it("readServedChains refuses a truncated read", async () => {
      const { ctx, query } = servedChainsContext()
      query.mockResolvedValue({ rows: [], more: true })
      await expect(Steps.contracts.sysio.opreg.readServedChains(ctx)).rejects.toThrow(
        `sysio.opreg::servchains has more than ${Steps.contracts.sysio.opreg.ServedChainReadLimit} rows; the read is truncated`
      )
    })

    it("readMembership picks the operator's row on the chain, absent when it never joined", async () => {
      const { ctx, query } = servedChainsContext(),
        ethereum = membershipRow("chainop.a", Constants.ETHEREUM_CHAIN_CODENAME, SysioContracts.SysioOpregChainServiceStatus.EVICTED),
        other = membershipRow("chainop.b", Constants.SOLANA_CHAIN_CODENAME, SysioContracts.SysioOpregChainServiceStatus.SERVING)
      query.mockResolvedValue({ rows: [ethereum, other], more: false })
      await expect(
        Steps.contracts.sysio.opreg.readMembership(ctx, "chainop.a", Constants.ETHEREUM_CHAIN_CODENAME)
      ).resolves.toBe(ethereum)
      await expect(
        Steps.contracts.sysio.opreg.readMembership(ctx, "chainop.a", Constants.SOLANA_CHAIN_CODENAME)
      ).resolves.toBeUndefined()
    })

    it("isMembershipRow matches the operator's row on the chain only", () => {
      const row = membershipRow(
        "chainop.a",
        Constants.ETHEREUM_CHAIN_CODENAME,
        SysioContracts.SysioOpregChainServiceStatus.SERVING
      )
      expect(
        Steps.contracts.sysio.opreg.isMembershipRow(row, "chainop.a", Constants.ETHEREUM_CHAIN_CODENAME)
      ).toBe(true)
      expect(
        Steps.contracts.sysio.opreg.isMembershipRow(row, "chainop.a", Constants.SOLANA_CHAIN_CODENAME)
      ).toBe(false)
      expect(
        Steps.contracts.sysio.opreg.isMembershipRow(row, "chainop.b", Constants.ETHEREUM_CHAIN_CODENAME)
      ).toBe(false)
    })

    it("isMembershipRow refuses a row whose chain cell is no slug", () => {
      const row = {
        ...membershipRow("chainop.a", Constants.ETHEREUM_CHAIN_CODENAME, SysioContracts.SysioOpregChainServiceStatus.SERVING),
        chain_code: "not a slug!"
      }
      expect(() =>
        Steps.contracts.sysio.opreg.isMembershipRow(row, "chainop.a", Constants.ETHEREUM_CHAIN_CODENAME)
      ).toThrow()
    })
  })

  describe("operators read", () => {
    /** A fixture context whose `sysio.opreg::operators` query is stubbable. */
    function operatorsContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, query: jest.spyOn(contract.tables.operators, "query") }
    }

    afterEach(() => jest.restoreAllMocks())

    it("readOperators returns every row of one complete read at OperatorTableReadLimit", async () => {
      const { ctx, query } = operatorsContext(),
        rows = [fixtureOperatorRow("acct.a1b2c"), fixtureOperatorRow("acct.d3e4f")]
      query.mockResolvedValue({ rows, more: false })
      await expect(Steps.contracts.sysio.opreg.readOperators(ctx)).resolves.toEqual(rows)
      expect(query).toHaveBeenCalledWith({
        limit: Steps.contracts.sysio.opreg.OperatorTableReadLimit
      })
    })

    it("readOperators refuses a truncated read", async () => {
      const { ctx, query } = operatorsContext()
      query.mockResolvedValue({ rows: [fixtureOperatorRow("acct.a1b2c")], more: true })
      await expect(Steps.contracts.sysio.opreg.readOperators(ctx)).rejects.toThrow(
        `sysio.opreg::operators has more than ${Steps.contracts.sysio.opreg.OperatorTableReadLimit} rows; the read is truncated`
      )
    })
  })
})
