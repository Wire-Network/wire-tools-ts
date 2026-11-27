import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** The packed chain code of the chain the per-chain cranks name. */
const EthereumChainCode = SlugName.from(Constants.ETHEREUM_CHAIN_CODENAME)

describe("Steps.contracts.sysio.msgch", () => {
  it("planBootstrap builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.msgch.planBootstrap(
      Report.Actor.Sysio,
      "bootstrap",
      "bootstrap every chain",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(step.runner).toBe(Steps.contracts.sysio.msgch.runBootstrap)
  })

  it("planChkcons carries the chain it cranks", () => {
    const step = Steps.contracts.sysio.msgch.planChkcons(
      Report.Actor.Sysio,
      "chkcons",
      "crank one chain's consensus",
      {},
      { chain_code: EthereumChainCode }
    )
    expect(step.input).toEqual({
      kind: "MsgchContractSteps.ChkconsInput",
      data: { chain_code: EthereumChainCode }
    })
    expect(step.runner).toBe(Steps.contracts.sysio.msgch.runChkcons)
  })

  it("planBootchain carries the chain it starts", () => {
    const step = Steps.contracts.sysio.msgch.planBootchain(
      Report.Actor.Sysio,
      "bootchain",
      "start one chain's epoch 1",
      {},
      { chain_code: EthereumChainCode }
    )
    expect(step.input).toEqual({
      kind: "MsgchContractSteps.BootchainInput",
      data: { chain_code: EthereumChainCode }
    })
    expect(step.runner).toBe(Steps.contracts.sysio.msgch.runBootchain)
  })

  describe("per-chain cranks", () => {
    afterEach(() => jest.restoreAllMocks())

    /** A real context whose `sysio.msgch` client is memoized for spying. */
    function msgchContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.msgch)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, contract }
    }

    it("runChkcons invokes msgch::chkcons with the step's data", async () => {
      const { ctx, contract } = msgchContext(),
        invoke = jest.spyOn(contract.actions.chkcons, "invoke").mockResolvedValue(undefined),
        step = Steps.contracts.sysio.msgch.planChkcons(Report.Actor.Sysio, "chkcons", "chkcons", {}, {
          chain_code: EthereumChainCode
        })
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(invoke).toHaveBeenCalledWith({ chain_code: EthereumChainCode })
    })

    it("runBootchain invokes msgch::bootchain with the step's data", async () => {
      const { ctx, contract } = msgchContext(),
        invoke = jest.spyOn(contract.actions.bootchain, "invoke").mockResolvedValue(undefined),
        step = Steps.contracts.sysio.msgch.planBootchain(Report.Actor.Sysio, "bootchain", "bootchain", {}, {
          chain_code: EthereumChainCode
        })
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(invoke).toHaveBeenCalledWith({ chain_code: EthereumChainCode })
    })

    it("an aborted crank pushes nothing", async () => {
      const { ctx, contract } = msgchContext(),
        invoke = jest.spyOn(contract.actions.chkcons, "invoke").mockResolvedValue(undefined),
        step = Steps.contracts.sysio.msgch.planChkcons(Report.Actor.Sysio, "chkcons", "chkcons", {}, {
          chain_code: EthereumChainCode
        })
      await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
