import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName, SysioDclaimChainkind } = SysioContracts

/** One `importseed` batch: a 20-byte EVM address credited 2.5 WIRE. */
const ImportseedData: SysioContracts.SysioDclaimImportseedAction = {
  chain: SysioDclaimChainkind.CHAIN_KIND_EVM,
  credits: [
    {
      native_address: "1111111111111111111111111111111111111111",
      wire_atomic: "2500000000"
    }
  ]
}

describe("Steps.contracts.sysio.dclaim", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.dclaim` client. */
  function dclaimContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.dclaim),
      getSysioContract = jest
        .spyOn(ctx.wire, "getSysioContract")
        .mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("setconfig builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.dclaim.planSetconfig(
      Report.Actor.Sysio,
      "init-dclaim",
      "initialize the dclaim cap_config",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("importseed carries the dclaim::importseed data and binds runImportseed", () => {
    const step = Steps.contracts.sysio.dclaim.planImportseed(
      Report.Actor.Sysio,
      "import-claims",
      "push dclaim::importseed",
      {},
      ImportseedData
    )
    expect(step.input).toEqual({
      kind: "DclaimContractSteps.ImportseedInput",
      data: ImportseedData
    })
    expect(step.runner).toBe(Steps.contracts.sysio.dclaim.runImportseed)
  })

  it("runImportseed pushes dclaim::importseed under the contract's own authority", async () => {
    const { ctx, contract, getSysioContract } = dclaimContext(),
      invoke = jest
        .spyOn(contract.actions.importseed, "invoke")
        .mockResolvedValue(undefined)
    await Steps.contracts.sysio.dclaim.runImportseed(
      ctx,
      { kind: "DclaimContractSteps.ImportseedInput", data: ImportseedData },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.dclaim)
    expect(invoke).toHaveBeenCalledWith(ImportseedData)
  })

  it("importdone carries the empty payload and binds runImportdone", () => {
    const step = Steps.contracts.sysio.dclaim.planImportdone(
      Report.Actor.Sysio,
      "seal-claims",
      "push dclaim::importdone",
      {},
      {}
    )
    expect(step.input).toEqual({
      kind: "DclaimContractSteps.ImportdoneInput",
      data: {}
    })
    expect(step.runner).toBe(Steps.contracts.sysio.dclaim.runImportdone)
  })

  it("runImportdone pushes dclaim::importdone, and an aborted signal pushes nothing", async () => {
    const { ctx, contract } = dclaimContext(),
      invoke = jest
        .spyOn(contract.actions.importdone, "invoke")
        .mockResolvedValue(undefined),
      aborted = new AbortController()
    await Steps.contracts.sysio.dclaim.runImportdone(
      ctx,
      { kind: "DclaimContractSteps.ImportdoneInput", data: {} },
      signal
    )
    expect(invoke).toHaveBeenCalledWith({})
    aborted.abort()
    await expect(
      Steps.contracts.sysio.dclaim.runImportdone(
        ctx,
        { kind: "DclaimContractSteps.ImportdoneInput", data: {} },
        aborted.signal
      )
    ).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("claim carries the dclaim::claim data and signs as the claiming account", async () => {
    const { ctx, contract } = dclaimContext(),
      invoke = jest
        .spyOn(contract.actions.claim, "invoke")
        .mockResolvedValue(undefined),
      step = Steps.contracts.sysio.dclaim.planClaim(
        Report.Actor.User,
        "claim",
        "claim the pending WIRE",
        {},
        { wire_account: "lcoethstaker" }
      )
    expect(step.input).toEqual({
      kind: "DclaimContractSteps.ClaimInput",
      data: { wire_account: "lcoethstaker" }
    })
    expect(step.runner).toBe(Steps.contracts.sysio.dclaim.runClaim)
    await Steps.contracts.sysio.dclaim.runClaim(ctx, step.input, signal)
    expect(invoke).toHaveBeenCalledWith(
      { wire_account: "lcoethstaker" },
      { authorization: [{ actor: "lcoethstaker", permission: "active" }] }
    )
  })
})
