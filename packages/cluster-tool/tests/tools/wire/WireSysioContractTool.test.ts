import { Constants } from "@wireio/cluster-tool"
import { WireSysioContractTool } from "@wireio/cluster-tool/tools/wire"

describe("WireSysioContractTool helpers", () => {
  it("sysioActiveAuthority is sysio@active only, no keys, in the generated authority shape", () => {
    expect(WireSysioContractTool.sysioActiveAuthority()).toEqual({
      threshold: 1,
      keys: [],
      accounts: [{ permission: { actor: "sysio", permission: "active" }, weight: 1 }]
    })
  })

  it("delegatedAuthority is the actor's active alone at weight and threshold 1", () => {
    expect(WireSysioContractTool.delegatedAuthority(Constants.NODE_OWNERS_AUTHORITY)).toEqual({
      threshold: WireSysioContractTool.DelegationWeight,
      keys: [],
      accounts: [
        {
          permission: { actor: "sysio.nodes", permission: "active" },
          weight: WireSysioContractTool.DelegationWeight
        }
      ]
    })
    expect(WireSysioContractTool.DelegationWeight).toBe(1)
  })

  it("sysioNullActiveAuthority delegates only to sysio.null@active, which nothing satisfies", () => {
    const authority = WireSysioContractTool.sysioNullActiveAuthority()
    expect(authority).toEqual({
      threshold: 1,
      keys: [],
      accounts: [
        { permission: { actor: "sysio.null", permission: "active" }, weight: 1 }
      ]
    })
    // It carries exactly the placeholder entries the governance RAM grant budgets for.
    expect(authority.accounts).toHaveLength(
      Constants.GOVERNANCE_AUTHORITY_PLACEHOLDER_ENTRIES
    )
  })

  it("sysioActiveCodeAuthority puts sysio@active first, then code accounts sorted by name", () => {
    const authority = WireSysioContractTool.sysioActiveCodeAuthority([
      "sysio.opreg",
      "sysio.msgch"
    ])
    expect(authority.accounts[0].permission).toEqual({
      actor: "sysio",
      permission: "active"
    })
    const codeAccounts = authority.accounts.slice(1)
    // chain name-value order: sysio.msgch sorts before sysio.opreg
    expect(codeAccounts.map(entry => entry.permission.actor)).toEqual([
      "sysio.msgch",
      "sysio.opreg"
    ])
    codeAccounts.forEach(entry =>
      expect(entry.permission.permission).toBe("sysio.code")
    )
    expect(authority.threshold).toBe(1)
    expect(authority.keys).toEqual([])
    expect(authority).not.toHaveProperty("waits")
  })

  it("packAbi packs a minimal abi_def into a hex string", () => {
    const hex = WireSysioContractTool.packAbi({
      version: "sysio::abi/1.2",
      types: [],
      structs: [],
      actions: [],
      tables: [],
      ricardian_clauses: [],
      error_messages: [],
      abi_extensions: [],
      variants: []
    })
    expect(typeof hex).toBe("string")
    expect(hex.length).toBeGreaterThan(0)
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true)
  })
})

describe("WireSysioContractTool.createSysioAccount", () => {
  it("defaults the active authority to sysio@active", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined)
    await new WireSysioContractTool({ invoke } as never).createSysioAccount(
      "sysio.opreg"
    )
    expect(invoke).toHaveBeenCalledWith(
      "sysio",
      "newaccount",
      {
        creator: "sysio",
        name: "sysio.opreg",
        owner: WireSysioContractTool.sysioActiveAuthority(),
        active: WireSysioContractTool.sysioActiveAuthority()
      },
      [{ actor: "sysio", permission: "active" }]
    )
  })

  it("keeps the owner on sysio@active when the active authority is given", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined)
    await new WireSysioContractTool({ invoke } as never).createSysioAccount(
      Constants.NODE_OWNERS_AUTHORITY,
      WireSysioContractTool.sysioNullActiveAuthority()
    )
    const [, , data] = invoke.mock.calls[0]
    expect(data.owner).toEqual(WireSysioContractTool.sysioActiveAuthority())
    expect(data.active).toEqual(WireSysioContractTool.sysioNullActiveAuthority())
  })
})

describe("WireSysioContractTool.compareNames", () => {
  it("orders by 64-bit name value, not by spelling", () => {
    expect(["sysio.opreg", "sysio", "sysio.msgch", "gova", "a"].sort(WireSysioContractTool.compareNames)).toEqual([
      "a",
      "gova",
      "sysio",
      "sysio.msgch",
      "sysio.opreg"
    ])
    expect(WireSysioContractTool.compareNames("gova", "gova")).toBe(0)
  })
})
