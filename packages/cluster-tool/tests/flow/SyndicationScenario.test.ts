import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { Keypair } from "@solana/web3.js"
import { SysioContracts } from "@wireio/sdk-core"
import { SyndicationScenario } from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  Steps,
  SyndicationUserSteps,
  outputKey
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal,
  { Actor } = Report,
  { SysioContractName } = SysioContracts,
  account = "synd.user"

/** Expose shared composition to exercise its production setup and cleanup boundaries. */
class Scenario extends SyndicationScenario {
  readonly name = "test-syndication"
  readonly description = "composition fixture"
  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [{ account, keypairName: account, linked: false }])
    this.planFinish(cluster)
  }
}

afterEach(() => jest.restoreAllMocks())

describe("syndication scenario accounting", () => {
  it("plans setup and restoration without executing a write", () => {
    const cluster = ClusterBuild.forContext(fixtureContext())
    new Scenario().plan(cluster)
    expect(cluster.children.map(child => child.name)).toEqual([
      "SyndicationSetup",
      "RestoreAndVerify"
    ])
  })
  it("round trips base units without floating point, including dust", () => {
    expect(
      SyndicationScenario.units(SyndicationScenario.quantity(2_000_000_001n))
    ).toBe(2_000_000_001n)
    expect(SyndicationScenario.quantity(0n)).toBe("0.000000000 LIQSOL")
    expect(() => SyndicationScenario.quantity(-1n)).toThrow("negative")
  })
  it("uses the account as resource-policy owner", () => {
    expect(SyndicationScenario.resourcePolicy(account).owner).toBe(account)
    expect(SyndicationScenario.resourcePolicy(account).issuer).not.toBe(account)
  })
  it("treats absent holdings as zero and refuses truncated reads", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.liq)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    const query = jest
      .spyOn(contract.tables.accounts, "query")
      .mockResolvedValue({ rows: [], more: false })
    expect(await SyndicationScenario.readBalance(ctx, account)).toBe(0n)
    query.mockResolvedValue({ rows: [], more: true })
    await expect(SyndicationScenario.readBalance(ctx, account)).rejects.toThrow(
      "truncated"
    )
  })
  it("reads the requested symbol rather than another holding", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.liq)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    jest.spyOn(contract.tables.accounts, "query").mockResolvedValue({
      rows: [
        { balance: "9.000000000 LIQETH", index_checkpoint: "0", owed_wire: 0 },
        { balance: "2.000000001 LIQSOL", index_checkpoint: "0", owed_wire: 0 }
      ],
      more: false
    })
    expect(await SyndicationScenario.readBalance(ctx, account)).toBe(
      2_000_000_001n
    )
  })
  it("reads fees and handles a pot not yet created", async () => {
    const ctx = fixtureContext(),
      read = jest
        .spyOn(WireSyndicationTool, "readFeepot")
        .mockResolvedValue(undefined)
    expect(await SyndicationScenario.readFees(ctx)).toBe(0n)
    read.mockResolvedValue({
      token_code: SyndicationScenario.Token,
      balance: "123",
      position: { index_checkpoint: "0", owed_wire: 0 }
    })
    expect(await SyndicationScenario.readFees(ctx)).toBe(123n)
  })
  it("refuses an absent epoch singleton", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.epoch)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    jest
      .spyOn(contract.tables.epochstate, "query")
      .mockResolvedValue({ rows: [], more: false })
    await expect(SyndicationScenario.readEpoch(ctx)).rejects.toThrow(
      "missing epoch"
    )
  })
  it("resolves runtime epochs and refuses a missing envelope", async () => {
    const ctx = fixtureContext(),
      key = outputKey<number>("test.epoch", "runtime epoch"),
      read = jest
        .spyOn(WireSyndicationTool, "readEnvelope")
        .mockResolvedValue(undefined)
    await expect(SyndicationScenario.readEnvelope(ctx, key)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    ctx.outputs.set(key, 7)
    await expect(SyndicationScenario.readEnvelope(ctx, key)).rejects.toThrow(
      "missing scenario envelope"
    )
    expect(read).toHaveBeenCalledWith(
      ctx,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      7
    )
  })
  it("restoration uses the captured configuration and never writes if it is missing", async () => {
    const ctx = fixtureContext(),
      step = SyndicationScenario.planRestoreConfig(
        Actor.Sysio,
        "restore",
        "restore",
        SyndicationScenario.WriteOptions
      ),
      run = jest
        .spyOn(Steps.contracts.sysio.synd, "runSetconfig")
        .mockResolvedValue()
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    const config: SysioContracts.SysioSyndSyndConfigType = {
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      synd_fee_bps: 17,
      desynd_fee_bps: 23,
      synd_burst: 100,
      synd_refill: 3,
      desynd_burst: 200,
      desynd_refill: 4,
      window_sec: 60,
      bounty: 5,
      challenge_extra: 6
    }
    ctx.outputs.set(SyndicationScenario.OriginalConfigKey, config)
    await step.runner(ctx, step.input, signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1].data).toEqual(config)
  })
  it("encodes the persisted wallet public key and fails when that wallet is missing", () => {
    const ctx = fixtureContext(),
      keypair = Keypair.generate(),
      load = jest
        .spyOn(SolanaFundingTool, "loadKeypair")
        .mockReturnValue(keypair)
    expect(
      SyndicationScenario.publicKey(ctx, {
        account,
        keypairName: account,
        linked: true
      })
    ).toBe(keypair.publicKey.toBuffer().toString("hex"))
    load.mockImplementation(() => {
      throw new Error("missing wallet")
    })
    expect(() =>
      SyndicationScenario.publicKey(ctx, {
        account,
        keypairName: account,
        linked: true
      })
    ).toThrow("missing wallet")
  })
  it("keeps the explicit crank as one existing contract step", () => {
    const step = SyndicationScenario.planCrank(
      Actor.User,
      "crank",
      "advance the syndication queue",
      SyndicationScenario.WriteOptions
    )
    expect(step.input.data.limit).toBe(SyndicationScenario.CrankLimit)
    expect(step.input.signer).toBe(SyndicationScenario.Bonder)
  })
})

describe("shared syndication user writes", () => {
  it("creates one policy and refuses an aborted write", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.roa)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    const invoke = jest
        .spyOn(contract.actions.addpolicy, "invoke")
        .mockResolvedValue(undefined),
      step = SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "policy",
        "policy",
        {},
        SyndicationScenario.resourcePolicy(account)
      )
    await step.runner(ctx, step.input, signal)
    expect(invoke).toHaveBeenCalledTimes(1)
    await expect(
      step.runner(ctx, step.input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it("links the persisted ED key in one createlink and refuses an absent wallet", async () => {
    const ctx = fixtureContext(),
      keypair = Keypair.generate(),
      load = jest
        .spyOn(SolanaFundingTool, "loadKeypair")
        .mockReturnValue(keypair),
      link = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined),
      step = SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link",
        "link",
        {},
        account,
        account
      )
    await step.runner(ctx, step.input, signal)
    expect(link).toHaveBeenCalledTimes(1)
    expect(link.mock.calls[0][1].account).toBe(account)
    load.mockImplementation(() => {
      throw new Error("missing wallet")
    })
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      "missing wallet"
    )
    expect(link).toHaveBeenCalledTimes(1)
  })
})
