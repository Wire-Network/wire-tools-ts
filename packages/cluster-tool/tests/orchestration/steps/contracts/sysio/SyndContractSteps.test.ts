import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

/** The account whose signature carries a permissionless push in the cases below. */
const CpuPayer = "cpu.payer"
/** The system account, which signs the governance actions. */
const SystemAccount = "sysio"

/** The `authorization` option a runner passes when `account@active` signs. */
function signedBy(account: string) {
  return { authorization: [{ actor: account, permission: "active" }] }
}

describe("Steps.contracts.sysio.synd", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.synd` client. */
  function syndContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.synd),
      getSysioContract = jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("setconfig carries the synd::setconfig data and binds runSetconfig", () => {
    const data: SysioContracts.SysioSyndSetconfigAction = {
      chain_code: "SOLANA",
      token_code: "LIQSOL",
      synd_fee_bps: 25,
      desynd_fee_bps: 50,
      synd_burst: 1_000_000_000_000,
      synd_refill: 1_000_000_000_000,
      desynd_burst: 1_000_000_000_000,
      desynd_refill: 1_000_000_000_000,
      window_sec: 60,
      bounty: 0,
      challenge_extra: 1_000_000_000,
      min_desyndicate: 1_000_000
    }
    const step = Steps.contracts.sysio.synd.planSetconfig(
      Report.Actor.Sysio,
      "synd-setconfig",
      "push synd::setconfig",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.SetconfigInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runSetconfig)
  })

  it("runSetconfig pushes synd::setconfig as the system account", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.setconfig, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndSetconfigAction = {
      chain_code: "SOLANA",
      token_code: "LIQSOL",
      synd_fee_bps: 25,
      desynd_fee_bps: 50,
      synd_burst: 1_000_000_000_000,
      synd_refill: 1_000_000_000_000,
      desynd_burst: 1_000_000_000_000,
      desynd_refill: 1_000_000_000_000,
      window_sec: 60,
      bounty: 0,
      challenge_extra: 1_000_000_000,
      min_desyndicate: 1_000_000
    }
    await Steps.contracts.sysio.synd.runSetconfig(
      ctx,
      { kind: "SyndContractSteps.SetconfigInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("crank carries the synd::crank data and binds runCrank", () => {
    const data: SysioContracts.SysioSyndCrankAction = { limit: 16 }
    const step = Steps.contracts.sysio.synd.planCrank(
      Report.Actor.Sysio,
      "synd-crank",
      "push synd::crank",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.CrankInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runCrank)
  })

  it("runCrank pushes synd::crank as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.crank, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndCrankAction = { limit: 16 }
    await Steps.contracts.sysio.synd.runCrank(
      ctx,
      { kind: "SyndContractSteps.CrankInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("challenge carries the synd::challenge data and binds runChallenge", () => {
    const data: SysioContracts.SysioSyndChallengeAction = { challenger: "challenger", chain_code: "SOLANA", token_code: "LIQSOL", epoch_index: 4 }
    const step = Steps.contracts.sysio.synd.planChallenge(
      Report.Actor.Sysio,
      "synd-challenge",
      "push synd::challenge",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.ChallengeInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runChallenge)
  })

  it("runChallenge pushes synd::challenge as the challenger", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.challenge, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndChallengeAction = { challenger: "challenger", chain_code: "SOLANA", token_code: "LIQSOL", epoch_index: 4 }
    await Steps.contracts.sysio.synd.runChallenge(
      ctx,
      { kind: "SyndContractSteps.ChallengeInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(data.challenger))
  })

  it("dropenv carries the synd::dropenv data and binds runDropenv", () => {
    const data: SysioContracts.SysioSyndDropenvAction = { chain_code: "SOLANA", token_code: "LIQSOL", epoch_index: 4 }
    const step = Steps.contracts.sysio.synd.planDropenv(
      Report.Actor.Sysio,
      "synd-dropenv",
      "push synd::dropenv",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.DropenvInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runDropenv)
  })

  it("runDropenv pushes synd::dropenv as the system account", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.dropenv, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndDropenvAction = { chain_code: "SOLANA", token_code: "LIQSOL", epoch_index: 4 }
    await Steps.contracts.sysio.synd.runDropenv(
      ctx,
      { kind: "SyndContractSteps.DropenvInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("desyndicate carries the synd::desyndicate data and binds runDesyndicate", () => {
    const data: SysioContracts.SysioSyndDesyndicateAction = { holder: "liq.holder", quantity: "2.000000000 LIQSOL" }
    const step = Steps.contracts.sysio.synd.planDesyndicate(
      Report.Actor.Sysio,
      "synd-desyndicate",
      "push synd::desyndicate",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.DesyndicateInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runDesyndicate)
  })

  it("runDesyndicate pushes synd::desyndicate as the holder", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.desyndicate, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndDesyndicateAction = { holder: "liq.holder", quantity: "2.000000000 LIQSOL" }
    await Steps.contracts.sysio.synd.runDesyndicate(
      ctx,
      { kind: "SyndContractSteps.DesyndicateInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(data.holder))
  })

  it("sweep carries the synd::sweep data and binds runSweep", () => {
    const data: SysioContracts.SysioSyndSweepAction = { account: "liq.holder", chain_kind: SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM }
    const step = Steps.contracts.sysio.synd.planSweep(
      Report.Actor.Sysio,
      "synd-sweep",
      "push synd::sweep",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.SweepInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runSweep)
  })

  it("runSweep pushes synd::sweep as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.sweep, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndSweepAction = { account: "liq.holder", chain_kind: SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM }
    await Steps.contracts.sysio.synd.runSweep(
      ctx,
      { kind: "SyndContractSteps.SweepInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("importsynd carries the synd::importsynd data and binds runImportsynd", () => {
    const data: SysioContracts.SysioSyndImportsyndAction = { chain_code: "SOLANA", token_code: "LIQSOL", credits: [{ pubkey: "ab".repeat(32), amount: 5_000_000_000 }] }
    const step = Steps.contracts.sysio.synd.planImportsynd(
      Report.Actor.Sysio,
      "synd-importsynd",
      "push synd::importsynd",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.ImportsyndInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runImportsynd)
  })

  it("runImportsynd pushes synd::importsynd under the contract's own authority", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.importsynd, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndImportsyndAction = { chain_code: "SOLANA", token_code: "LIQSOL", credits: [{ pubkey: "ab".repeat(32), amount: 5_000_000_000 }] }
    await Steps.contracts.sysio.synd.runImportsynd(
      ctx,
      { kind: "SyndContractSteps.ImportsyndInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data)
  })

  it("importdone carries the synd::importdone data and binds runImportdone", () => {
    const data: SysioContracts.SysioSyndImportdoneAction = {}
    const step = Steps.contracts.sysio.synd.planImportdone(
      Report.Actor.Sysio,
      "synd-importdone",
      "push synd::importdone",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.ImportdoneInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runImportdone)
  })

  it("runImportdone pushes synd::importdone under the contract's own authority", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.importdone, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndImportdoneAction = {}
    await Steps.contracts.sysio.synd.runImportdone(
      ctx,
      { kind: "SyndContractSteps.ImportdoneInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data)
  })

  it("sweepyield carries the synd::sweepyield data and binds runSweepyield", () => {
    const data: SysioContracts.SysioSyndSweepyieldAction = { token_code: "LIQSOL" }
    const step = Steps.contracts.sysio.synd.planSweepyield(
      Report.Actor.Sysio,
      "synd-sweepyield",
      "push synd::sweepyield",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "SyndContractSteps.SweepyieldInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.synd.runSweepyield)
  })

  it("runSweepyield pushes synd::sweepyield as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = syndContext(),
      invoke = jest.spyOn(contract.actions.sweepyield, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioSyndSweepyieldAction = { token_code: "LIQSOL" }
    await Steps.contracts.sysio.synd.runSweepyield(
      ctx,
      { kind: "SyndContractSteps.SweepyieldInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.synd)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("runSetconfig pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = syndContext(),
      invoke = jest.spyOn(contract.actions.setconfig, "invoke").mockResolvedValue(undefined),
      controller = new AbortController(),
      data: SysioContracts.SysioSyndSetconfigAction = {
      chain_code: "SOLANA",
      token_code: "LIQSOL",
      synd_fee_bps: 25,
      desynd_fee_bps: 50,
      synd_burst: 1_000_000_000_000,
      synd_refill: 1_000_000_000_000,
      desynd_burst: 1_000_000_000_000,
      desynd_refill: 1_000_000_000_000,
      window_sec: 60,
      bounty: 0,
      challenge_extra: 1_000_000_000,
      min_desyndicate: 1_000_000
    }
    controller.abort()
    await expect(
      Steps.contracts.sysio.synd.runSetconfig(
        ctx,
        { kind: "SyndContractSteps.SetconfigInput", data },
        controller.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
