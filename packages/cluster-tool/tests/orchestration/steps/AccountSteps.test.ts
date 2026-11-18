import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireSysioContractTool } from "@wireio/cluster-tool/tools/wire"

describe("Steps.account.createSystem", () => {
  it("carries the system account as typed input", () => {
    const step = Steps.account.planCreateSystem(
      Report.Actor.Sysio,
      "create-opreg",
      "create sysio.opreg system account",
      {},
      "sysio.opreg"
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.name).toBe("create-opreg")
    expect(step.input.kind).toBe("AccountSteps.CreateSystemInput")
    expect(step.input.account).toBe("sysio.opreg")
    expect(step.input.active).toEqual(
      WireSysioContractTool.sysioActiveAuthority()
    )
    expect(typeof step.runner).toBe("function")
  })

  it("carries an explicit active authority for a governance authority", () => {
    const step = Steps.account.planCreateSystem(
      Report.Actor.Sysio,
      "create-sysio.nodes",
      "create sysio.nodes",
      {},
      Constants.NODE_OWNERS_AUTHORITY,
      WireSysioContractTool.sysioNullActiveAuthority()
    )
    expect(step.input).toEqual({
      kind: "AccountSteps.CreateSystemInput",
      account: "sysio.nodes",
      active: WireSysioContractTool.sysioNullActiveAuthority()
    })
    expect(step.runner).toBe(Steps.account.runCreateSystem)
  })

  it("creates the account with its owner on sysio@active and the carried active", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined),
      ctx = { wire: { invoke } } as never,
      active = WireSysioContractTool.sysioNullActiveAuthority()
    await Steps.account.runCreateSystem(
      ctx,
      {
        kind: "AccountSteps.CreateSystemInput",
        account: Constants.COUNCIL_AUTHORITY,
        active
      },
      new AbortController().signal
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      "sysio",
      "newaccount",
      {
        creator: "sysio",
        name: "sysio.cncl",
        owner: WireSysioContractTool.sysioActiveAuthority(),
        active
      },
      [{ actor: "sysio", permission: "active" }]
    )
  })

  it("creates nothing once the step is aborted", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined),
      ctx = { wire: { invoke } } as never
    await expect(
      Steps.account.runCreateSystem(
        ctx,
        {
          kind: "AccountSteps.CreateSystemInput",
          account: Constants.COUNCIL_AUTHORITY,
          active: WireSysioContractTool.sysioNullActiveAuthority()
        },
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("Steps.account.createKeyed", () => {
  it("carries account + key + default sysio creator", () => {
    const step = Steps.account.planCreateKeyed(
      Report.Actor.Producer,
      "create-producer",
      "create a keyed producer account",
      {},
      "produceraaa",
      "PUB_K1_producerkey"
    )
    expect(step.actor).toBe(Report.Actor.Producer)
    expect(step.input.kind).toBe("AccountSteps.CreateKeyedInput")
    expect(step.input.account).toBe("produceraaa")
    expect(step.input.publicKey).toBe("PUB_K1_producerkey")
    expect(step.input.creator).toBe("sysio")
  })

  it("honors an explicit creator override", () => {
    const step = Steps.account.planCreateKeyed(
      Report.Actor.User,
      "create-user",
      "create a keyed user account from a non-sysio creator",
      {},
      "useraccount",
      "PUB_K1_userkey",
      "creatoracct"
    )
    expect(step.input.creator).toBe("creatoracct")
  })
})

describe("Steps.account.ramGrant", () => {
  it("carries the account and the bytes added to its RAM limit", () => {
    const step = Steps.account.planRamGrant(
      Report.Actor.Sysio,
      "fund-andon-permission-ram",
      "fund RAM for sysio.andon native permissions",
      {},
      "sysio.andon",
      10_400
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({
      kind: "AccountSteps.RamGrantInput",
      account: "sysio.andon",
      ramBytes: 10_400
    })
    expect(step.runner).toBe(Steps.account.runRamGrant)
  })

  it("performs one grant through the WIRE client and refuses an aborted run", async () => {
    const grantRam = jest.fn().mockResolvedValue(undefined),
      ctx = { wire: { grantRam } } as never,
      input = {
        kind: "AccountSteps.RamGrantInput" as const,
        account: "sysio.andon",
        ramBytes: 10_400
      }
    await Steps.account.runRamGrant(ctx, input, new AbortController().signal)
    expect(grantRam).toHaveBeenCalledTimes(1)
    expect(grantRam).toHaveBeenCalledWith("sysio.andon", 10_400)
    await expect(
      Steps.account.runRamGrant(ctx, input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(grantRam).toHaveBeenCalledTimes(1)
  })
})
