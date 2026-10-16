import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** One importseed batch: an EVM credit in WIRE atomic units. */
const seedBatch: SysioContracts.SysioDclaimImportseedAction = {
  chain: SysioContracts.SysioDclaimChainkind.CHAIN_KIND_EVM,
  credits: [{ native_address: "f39fd6e51aad88f6f4ce6ab8827279cfffb92266", wire_atomic: "5000000000" }]
}

describe("Steps.contracts.sysio.dclaim", () => {
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

  it("importseed carries the dclaim::importseed data; importdone is input-less", () => {
    const seed = Steps.contracts.sysio.dclaim.planImportseed(
        Report.Actor.Sysio,
        "import-pretoken-seed-0",
        "seed one batch",
        {},
        seedBatch
      ),
      done = Steps.contracts.sysio.dclaim.planImportdone(
        Report.Actor.Sysio,
        "seal-pretoken-import",
        "seal",
        {}
      )
    expect(seed.input.kind).toBe("DclaimContractSteps.ImportseedInput")
    expect(seed.input.data).toBe(seedBatch)
    expect(seed.runner).toBe(Steps.contracts.sysio.dclaim.runImportseed)
    expect(done.input).toBeNull()
    expect(done.runner).toBe(Steps.contracts.sysio.dclaim.runImportdone)
  })

  describe("runners", () => {
    function dclaimContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.dclaim)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, contract }
    }
    afterEach(() => jest.restoreAllMocks())

    it("pushes dclaim::importseed with the batch, and dclaim::importdone with nothing", async () => {
      const { ctx, contract } = dclaimContext(),
        importseed = jest.spyOn(contract.actions.importseed, "invoke").mockResolvedValue(undefined),
        importdone = jest.spyOn(contract.actions.importdone, "invoke").mockResolvedValue(undefined),
        signal = new AbortController().signal
      await Steps.contracts.sysio.dclaim.runImportseed(
        ctx,
        { kind: "DclaimContractSteps.ImportseedInput", data: seedBatch },
        signal
      )
      await Steps.contracts.sysio.dclaim.runImportdone(ctx, null, signal)
      expect(importseed).toHaveBeenCalledWith(seedBatch)
      expect(importdone).toHaveBeenCalledWith({})
    })

    it("pushes nothing once the step is aborted", async () => {
      const { ctx, contract } = dclaimContext(),
        importseed = jest.spyOn(contract.actions.importseed, "invoke").mockResolvedValue(undefined),
        controller = new AbortController()
      controller.abort()
      await expect(
        Steps.contracts.sysio.dclaim.runImportseed(
          ctx,
          { kind: "DclaimContractSteps.ImportseedInput", data: seedBatch },
          controller.signal
        )
      ).rejects.toThrow()
      expect(importseed).not.toHaveBeenCalled()
    })
  })
})
