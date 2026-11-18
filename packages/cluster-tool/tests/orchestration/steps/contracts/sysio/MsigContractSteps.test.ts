import { identity } from "lodash"
import { SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

const MsigSteps = Steps.contracts.sysio.msig

/** A transaction header the stubbed `get_info` hands out. */
const Header = {
  expiration: "2026-11-10T00:00:00",
  ref_block_num: 1,
  ref_block_prefix: 2,
  max_net_usage_words: 0,
  max_cpu_usage_ms: 0,
  delay_sec: 0
}

/** The ABI of a contract with one `transfer(from, to, quantity, memo)` action. */
const TokenAbi = {
  version: "sysio::abi/1.2",
  types: [],
  structs: [
    {
      name: "transfer",
      base: "",
      fields: [
        { name: "from", type: "name" },
        { name: "to", type: "name" },
        { name: "quantity", type: "asset" },
        { name: "memo", type: "string" }
      ]
    }
  ],
  actions: [{ name: "transfer", type: "transfer", ricardian_contract: "" }],
  tables: [],
  ricardian_clauses: [],
  variants: []
}

/** A proposed `sysio.token::transfer` declared by `sysio@active`. */
const ProposedTransfer: WireClient.ActionPayload<SysioContracts.SysioContractName.token, "transfer"> = {
  contract: SysioContracts.SysioContractName.token,
  account: "sysio.token",
  name: "transfer",
  authorization: [{ actor: "sysio", permission: "active" }],
  data: {
    from: "sysio",
    to: "cnla",
    quantity: "1.000000000 WIRE",
    memo: "probe"
  }
}

/** The proposal every case proposes: `gova/probe`, asking `gova@active` to approve. */
const Proposal: Steps.contracts.sysio.msig.ProposeData = {
  proposer: "gova",
  proposal_name: "probe",
  requested: [{ actor: "gova", permission: "active" }]
}
/** `govb@active`'s approval of {@link Proposal}. */
const Approval: SysioContracts.SysioMsigApproveAction = {
  proposer: "gova",
  proposal_name: "probe",
  level: { actor: "govb", permission: "active" }
}
/** `govc`'s execution of {@link Proposal}. */
const Execution: SysioContracts.SysioMsigExecAction = {
  proposer: "gova",
  proposal_name: "probe",
  executer: "govc"
}

/** A context whose chain reads and pushes are doubled at their seams. */
function msigContext() {
  const invokeTransaction = jest.fn().mockResolvedValue(undefined),
    getAbi = jest.fn().mockResolvedValue({ abi: TokenAbi }),
    getInfo = jest.fn().mockResolvedValue({
      getTransactionHeader: () => Header
    }),
    computeTransaction = jest.fn().mockResolvedValue({}),
    wire = {
      invokeTransaction,
      api: {
        v1: {
          chain: {
            get_abi: getAbi,
            get_info: getInfo,
            compute_transaction: computeTransaction
          }
        }
      }
    }
  return { ctx: { wire } as never, wire: wire as never, invokeTransaction, getAbi, computeTransaction }
}

describe("Steps.contracts.sysio.msig", () => {
  const signal = new AbortController().signal

  it("propose carries the generated propose data less its trx, and the typed proposed actions", () => {
    const step = MsigSteps.planPropose(
      Report.Actor.User,
      "propose-probe",
      "propose a probe",
      {},
      Proposal,
      [ProposedTransfer]
    )
    expect(step.input).toEqual({
      kind: "MsigContractSteps.ProposeInput",
      data: Proposal,
      actions: [ProposedTransfer]
    })
    expect(step.runner).toBe(MsigSteps.runPropose)
  })

  it("runPropose pushes ONE propose authorized by the proposer's sysio.payer then active", async () => {
    const { ctx, invokeTransaction, getAbi } = msigContext()
    await MsigSteps.runPropose(
      ctx,
      {
        kind: "MsigContractSteps.ProposeInput",
        data: Proposal,
        actions: [ProposedTransfer, ProposedTransfer]
      },
      signal
    )
    // One ABI read per distinct contract the proposed transaction touches.
    expect(getAbi).toHaveBeenCalledTimes(1)
    expect(getAbi).toHaveBeenCalledWith("sysio.token")
    expect(invokeTransaction).toHaveBeenCalledTimes(1)
    const [action] = invokeTransaction.mock.calls[0]
    expect(String(action.account)).toBe("sysio.msig")
    expect(String(action.name)).toBe("propose")
    expect(action.authorization.map(String)).toEqual([
      "gova@sysio.payer",
      "gova@active"
    ])
  })

  it("approve and exec push one encoded action each, signed by the approver and the executer", async () => {
    const { ctx, invokeTransaction } = msigContext()
    await MsigSteps.runApprove(
      ctx,
      { kind: "MsigContractSteps.ApproveInput", data: Approval },
      signal
    )
    await MsigSteps.runExec(
      ctx,
      { kind: "MsigContractSteps.ExecInput", data: Execution },
      signal
    )
    expect(invokeTransaction).toHaveBeenCalledTimes(2)
    const [[approve], [exec]] = invokeTransaction.mock.calls
    expect([String(approve.account), String(approve.name)]).toEqual([
      "sysio.msig",
      "approve"
    ])
    expect(approve.authorization.map(String)).toEqual(["govb@active"])
    expect([String(exec.account), String(exec.name)]).toEqual(["sysio.msig", "exec"])
    expect(exec.authorization.map(String)).toEqual(["govc@active"])
  })

  it("approve and exec factories carry their typed inputs", () => {
    const approve = MsigSteps.planApprove(Report.Actor.User, "approve", "approve", {}, Approval),
      exec = MsigSteps.planExec(Report.Actor.User, "exec", "exec", {}, Execution)
    expect(approve.input).toEqual({ kind: "MsigContractSteps.ApproveInput", data: Approval })
    expect(approve.runner).toBe(MsigSteps.runApprove)
    expect(exec.input).toEqual({ kind: "MsigContractSteps.ExecInput", data: Execution })
    expect(exec.runner).toBe(MsigSteps.runExec)
  })

  it("pushes nothing once a step is aborted", async () => {
    const { ctx, invokeTransaction } = msigContext()
    await expect(
      MsigSteps.runExec(
        ctx,
        { kind: "MsigContractSteps.ExecInput", data: Execution },
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(invokeTransaction).not.toHaveBeenCalled()
  })

  describe("isExecutable", () => {
    const execution: SysioContracts.SysioMsigExecAction = { ...Execution, executer: "gova" }

    it("is true when the dry run's trace was processed without an exception", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockResolvedValue({ processed: { id: "trx", except: null } })
      expect(await MsigSteps.isExecutable(wire, execution)).toBe(true)
      expect(computeTransaction).toHaveBeenCalledTimes(1)
    })

    it("refuses a response that carries no processed trace rather than reading it as executable", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockResolvedValue({})
      await expect(MsigSteps.isExecutable(wire, execution)).rejects.toThrow(
        /dry-run exec of gova\/probe returned no processed trace/
      )
    })

    it("is false when the node answers with a failure trace refusing the approvals", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockResolvedValue({
        processed: {
          except: {
            code: 3050003,
            name: "sysio_assert_message_exception",
            stack: [{ format: "assertion failure with message: ${s}", data: { s: "transaction authorization failed" } }]
          }
        }
      })
      expect(await MsigSteps.isExecutable(wire, execution)).toBe(false)
    })

    it("rethrows any other failure trace", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockResolvedValue({
        processed: { except: { name: "proposal_missing", message: "proposal not found" } }
      })
      await expect(MsigSteps.isExecutable(wire, execution)).rejects.toThrow(
        /dry-run exec of gova\/probe failed[\s\S]*proposal not found/
      )
    })

    it("is false when the contract refuses the approvals", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockRejectedValue(
        new Error("assertion failure with message: transaction authorization failed")
      )
      expect(await MsigSteps.isExecutable(wire, execution)).toBe(false)
    })

    it("rethrows any other failure with its cause", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockRejectedValue(new Error("proposal not found"))
      const failure = await MsigSteps.isExecutable(wire, execution).then(
        () => null,
        identity<Error>
      )
      expect(failure?.message).toMatch(/dry-run exec of gova\/probe failed/)
      expect((failure?.cause as Error)?.message).toBe("proposal not found")
    })
  })

  describe("isProposable", () => {
    const input: Steps.contracts.sysio.msig.ProposeInput = {
      kind: "MsigContractSteps.ProposeInput",
      data: Proposal,
      actions: [ProposedTransfer]
    }

    it("is true when the dry-run propose's trace was processed without an exception, and pushes nothing", async () => {
      const { wire, computeTransaction, invokeTransaction } = msigContext()
      computeTransaction.mockResolvedValue({ processed: { id: "trx", except: null } })
      expect(await MsigSteps.isProposable(wire, input)).toBe(true)
      const [[transaction]] = computeTransaction.mock.calls
      expect(String(transaction.actions[0].name)).toBe("propose")
      expect(transaction.actions).toHaveLength(1)
      expect(invokeTransaction).not.toHaveBeenCalled()
    })

    it("is false when the contract refuses the requested permissions", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockRejectedValue(
        new Error("assertion failure with message: transaction authorization failed")
      )
      expect(await MsigSteps.isProposable(wire, input)).toBe(false)
    })

    it("rethrows any other failure, naming the proposal", async () => {
      const { wire, computeTransaction } = msigContext()
      computeTransaction.mockRejectedValue(new Error("proposal exists"))
      await expect(MsigSteps.isProposable(wire, input)).rejects.toThrow(
        /dry-run propose of gova\/probe failed/
      )
    })
  })
})
