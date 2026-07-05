import { WireSysioContractTool } from "@wireio/cluster-tool/tools/wire"

describe("WireSysioContractTool helpers", () => {
  it("sysioActiveAuthority is sysio@active only, no keys", () => {
    const authority = WireSysioContractTool.sysioActiveAuthority()
    expect(authority.threshold).toBe(1)
    expect(authority.keys).toEqual([])
    expect(authority.accounts).toEqual([
      { permission: { actor: "sysio", permission: "active" }, weight: 1 }
    ])
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
