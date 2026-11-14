import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireSysioContractTool } from "@wireio/cluster-tool/tools/wire"
import { AccountObjectFixture } from "../../fixtures/AccountObjectFixture.js"

const Governance = Steps.governance

/** A WIRE client whose `get_account` answers `sysio.nodes` with the given `active` delegations. */
function nodesWire(threshold: number, members: string[]) {
  return {
    api: {
      v1: {
        chain: {
          get_account: jest.fn().mockResolvedValue(
            AccountObjectFixture.account("sysio.nodes", [
              AccountObjectFixture.permission("owner", "", 1, [], ["sysio@active"]),
              AccountObjectFixture.permission("active", "owner", threshold, [], members)
            ])
          )
        }
      }
    }
  }
}

describe("Steps.governance", () => {
  it("supermajorityAuthority lists every member's active in chain name order at weight 1, with no key", () => {
    expect(Governance.supermajorityAuthority(["govc", "gova", "govd", "govb"])).toEqual({
      threshold: 3,
      keys: [],
      accounts: ["gova", "govb", "govc", "govd"].map(actor => ({
        permission: { actor, permission: "active" },
        weight: 1
      }))
    })
  })

  it("hands sysio to the node owners as syncnodes, then active, then owner", () => {
    const actions = Governance.handoffActions(Constants.NODE_OWNERS_AUTHORITY)
    expect(actions.map(action => `${action.account}::${action.name}`)).toEqual([
      "sysio.councl::syncnodes",
      "sysio::updateauth",
      "sysio::updateauth"
    ])
    const [sync, active, owner] = actions
    expect(sync.data).toEqual({ caller: "sysio" })
    expect(sync.authorization).toEqual([{ actor: "sysio", permission: "active" }])
    expect(active.data).toEqual({
      account: "sysio",
      permission: "active",
      parent: "owner",
      auth: WireSysioContractTool.delegatedAuthority(Constants.NODE_OWNERS_AUTHORITY)
    })
    expect(owner.data).toEqual({
      account: "sysio",
      permission: "owner",
      parent: "",
      auth: WireSysioContractTool.delegatedAuthority(Constants.NODE_OWNERS_AUTHORITY)
    })
    // `sysio@owner` is the one permission that may change both.
    ;[active, owner].forEach(action =>
      expect(action.authorization).toEqual([{ actor: "sysio", permission: "owner" }])
    )
  })

  it("hands sysio to the council with the two repoints only: nothing re-syncs sysio.cncl", () => {
    const actions = Governance.handoffActions(Constants.COUNCIL_AUTHORITY)
    expect(actions).toHaveLength(2)
    expect(actions.map(action => action.data)).toEqual([
      expect.objectContaining({
        permission: "active",
        auth: WireSysioContractTool.delegatedAuthority(Constants.COUNCIL_AUTHORITY)
      }),
      expect.objectContaining({
        permission: "owner",
        auth: WireSysioContractTool.delegatedAuthority(Constants.COUNCIL_AUTHORITY)
      })
    ])
  })

  it("planHandoff records the authority and its actions, and pushes them as ONE transaction once the authority is written", async () => {
    const step = Governance.planHandoff(
        Report.Actor.Sysio,
        "handoff",
        "hand sysio to the node owners",
        {},
        Constants.NODE_OWNERS_AUTHORITY
      ),
      invokeTransaction = jest.fn().mockResolvedValue(undefined),
      wire = { ...nodesWire(3, ["gova@active", "govb@active", "govc@active"]), invokeTransaction }
    expect(step.input).toEqual({
      kind: "GovernanceSteps.HandoffInput",
      authority: "sysio.nodes",
      actions: Governance.handoffActions(Constants.NODE_OWNERS_AUTHORITY)
    })
    expect(step.runner).toBe(Governance.runHandoff)
    await Governance.runHandoff({ wire } as never, step.input, new AbortController().signal)
    expect(wire.api.v1.chain.get_account).toHaveBeenCalledWith("sysio.nodes")
    expect(invokeTransaction).toHaveBeenCalledTimes(1)
    expect(invokeTransaction).toHaveBeenCalledWith(...step.input.actions)
    await expect(
      Governance.runHandoff({ wire } as never, step.input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(invokeTransaction).toHaveBeenCalledTimes(1)
  })

  it("refuses to hand sysio to an authority still holding the sysio.null@active placeholder, and pushes nothing", async () => {
    const invokeTransaction = jest.fn().mockResolvedValue(undefined),
      wire = { ...nodesWire(1, ["sysio.null@active"]), invokeTransaction },
      input = Governance.planHandoff(
        Report.Actor.Sysio,
        "handoff",
        "hand sysio to the council",
        {},
        Constants.COUNCIL_AUTHORITY
      ).input
    await expect(
      Governance.runHandoff({ wire } as never, input, new AbortController().signal)
    ).rejects.toThrow(/refusing to hand sysio to sysio\.cncl: .*sysio\.null@active placeholder/)
    expect(invokeTransaction).not.toHaveBeenCalled()
  })

  describe("assertAuthorityWritten", () => {
    it("accepts an authority that names its members", async () => {
      await expect(
        Governance.assertAuthorityWritten(
          nodesWire(2, ["gova@active", "govb@active"]) as never,
          Constants.NODE_OWNERS_AUTHORITY
        )
      ).resolves.toBeUndefined()
    })

    it("refuses exactly the placeholder the bootstrap creates", async () => {
      await expect(
        Governance.assertAuthorityWritten(
          nodesWire(1, ["sysio.null@active"]) as never,
          Constants.NODE_OWNERS_AUTHORITY
        )
      ).rejects.toThrow(/still the unwritten sysio\.null@active placeholder/)
    })
  })

  describe("readAuthority", () => {
    const wire = nodesWire(2, ["govb@active", "gova@active"]) as never

    it("reads the permission's authority with plain numbers", async () => {
      expect(await Governance.readAuthority(wire, "sysio.nodes", "active")).toEqual(
        Governance.supermajorityAuthority(["gova", "govb"])
      )
    })

    it("refuses a permission the account does not have", async () => {
      await expect(Governance.readAuthority(wire, "sysio.nodes", "pull")).rejects.toThrow(
        /no permission pull/
      )
    })
  })
})
