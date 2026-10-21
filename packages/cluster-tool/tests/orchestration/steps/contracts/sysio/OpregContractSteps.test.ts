import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../../../outputs/operatorAccountFixture.js"
import { fixtureOperatorRow } from "./opregOperatorRowFixture.js"

const OperatorLabel = "batchop.a",
  GeneratedAccount = "wireno.x3f9k",
  AuditReason = "test live-group degradation",
  ProcessbatchData = { was_eligible: false, is_eligible: true } as const

function terminateFixture() {
  const ctx = fixtureContext()
  ctx.keyStore.setOperator(
    fixtureOperatorAccount(OperatorLabel, OperatorType.BATCH, GeneratedAccount)
  )
  const contract = ctx.wire.getSysioContract(
      SysioContracts.SysioContractName.opreg
    ),
    invoke = jest
      .spyOn(contract.actions.terminate, "invoke")
      .mockResolvedValue(undefined)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  return { ctx, invoke }
}

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

  it("terminate carries the operator label and audit reason", () => {
    const step = Steps.contracts.sysio.opreg.planTerminate(
      Report.Actor.Sysio,
      "terminate-batchop-a",
      "administratively remove batchop.a",
      {},
      OperatorLabel,
      { reason: AuditReason }
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("OpregContractSteps.TerminateInput")
    expect(step.input.label).toBe(OperatorLabel)
    expect(step.input.data).toEqual({ reason: AuditReason })
    expect(typeof step.runner).toBe("function")
  })

  it("terminate resolves the operator label and invokes the generated account", async () => {
    const { ctx, invoke } = terminateFixture()

    await Steps.contracts.sysio.opreg.runTerminate(
      ctx,
      {
        kind: "OpregContractSteps.TerminateInput",
        label: OperatorLabel,
        data: { reason: AuditReason }
      },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({
      account: GeneratedAccount,
      reason: AuditReason
    })
  })

  it("terminate rejects a pre-aborted signal without resolving or invoking", async () => {
    const { ctx, invoke } = terminateFixture(),
      assertOperator = jest.spyOn(ctx.keyStore, "assertOperator"),
      controller = new AbortController()
    controller.abort()

    await expect(
      Steps.contracts.sysio.opreg.runTerminate(
        ctx,
        {
          kind: "OpregContractSteps.TerminateInput",
          label: OperatorLabel,
          data: { reason: AuditReason }
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })

    expect(assertOperator).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("processbatch carries the operator label and eligibility transition", () => {
    const step = Steps.contracts.sysio.opreg.planProcessbatch(
      Report.Actor.Sysio,
      "activate-batchop-a",
      "mark batchop.a eligible",
      {},
      OperatorLabel,
      ProcessbatchData
    )

    expect(step.input).toEqual({
      kind: "OpregContractSteps.ProcessbatchInput",
      label: OperatorLabel,
      data: ProcessbatchData
    })
    expect(step.runner).toBe(Steps.contracts.sysio.opreg.runProcessbatch)
  })

  it("processbatch resolves the operator label and invokes the generated account", async () => {
    const { ctx } = terminateFixture(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.opreg
      ),
      invoke = jest
        .spyOn(contract.actions.processbatch, "invoke")
        .mockResolvedValue(undefined)

    await Steps.contracts.sysio.opreg.runProcessbatch(
      ctx,
      {
        kind: "OpregContractSteps.ProcessbatchInput",
        label: OperatorLabel,
        data: ProcessbatchData
      },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledWith({
      account: GeneratedAccount,
      ...ProcessbatchData
    })
  })

  it("processbatch rejects a pre-aborted signal before resolving the label", async () => {
    const { ctx } = terminateFixture(),
      assertOperator = jest.spyOn(ctx.keyStore, "assertOperator"),
      controller = new AbortController()
    controller.abort()

    await expect(
      Steps.contracts.sysio.opreg.runProcessbatch(
        ctx,
        {
          kind: "OpregContractSteps.ProcessbatchInput",
          label: OperatorLabel,
          data: ProcessbatchData
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(assertOperator).not.toHaveBeenCalled()
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
        contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.opreg
        )
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
      expect(step.input).toEqual({
        kind: "OpregContractSteps.DepositInput",
        data
      })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runDeposit)
    })

    it("runDeposit signs as the depositing operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest
          .spyOn(contract.actions.deposit, "invoke")
          .mockResolvedValue(undefined),
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
        invoke = jest
          .spyOn(contract.actions.deposit, "invoke")
          .mockResolvedValue(undefined),
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
      expect(step.input).toEqual({
        kind: "OpregContractSteps.WithdrawInput",
        data
      })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runWithdraw)
    })

    it("runWithdraw signs as the withdrawing operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest
          .spyOn(contract.actions.withdraw, "invoke")
          .mockResolvedValue(undefined),
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
        .mockRejectedValue(
          new Error("unsupported depot-native collateral token")
        )
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
      expect(step.input).toEqual({
        kind: "OpregContractSteps.ClaimremitInput",
        data
      })
      expect(step.runner).toBe(Steps.contracts.sysio.opreg.runClaimremit)
    })

    it("runClaimremit signs as the claiming operator", async () => {
      const { ctx, contract } = opregContext(),
        invoke = jest
          .spyOn(contract.actions.claimremit, "invoke")
          .mockResolvedValue(undefined),
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
        invoke = jest
          .spyOn(contract.actions.claimremit, "invoke")
          .mockResolvedValue(undefined),
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

  describe("operators read", () => {
    /** A fixture context whose `sysio.opreg::operators` query is stubbable. */
    function operatorsContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.opreg
        )
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, query: jest.spyOn(contract.tables.operators, "query") }
    }

    afterEach(() => jest.restoreAllMocks())

    it("readOperators returns every row of one complete read at OperatorTableReadLimit", async () => {
      const { ctx, query } = operatorsContext(),
        rows = [
          fixtureOperatorRow("wireno.a1b2c"),
          fixtureOperatorRow("wireno.d3e4f")
        ]
      query.mockResolvedValue({ rows, more: false })
      await expect(
        Steps.contracts.sysio.opreg.readOperators(ctx)
      ).resolves.toEqual(rows)
      expect(query).toHaveBeenCalledWith({
        limit: Steps.contracts.sysio.opreg.OperatorTableReadLimit
      })
    })

    it("readOperators refuses a truncated read", async () => {
      const { ctx, query } = operatorsContext()
      query.mockResolvedValue({
        rows: [fixtureOperatorRow("wireno.a1b2c")],
        more: true
      })
      await expect(
        Steps.contracts.sysio.opreg.readOperators(ctx)
      ).rejects.toThrow(
        `sysio.opreg::operators has more than ${Steps.contracts.sysio.opreg.OperatorTableReadLimit} rows; the read is truncated`
      )
    })
  })
})
