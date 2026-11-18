import { SysioContracts } from "@wireio/sdk-core"
import { NodeOwnerTier } from "@wireio/opp-typescript-models"
import { WireNodeOwnerTool } from "@wireio/cluster-tool/tools/wire"

/** A WIRE client whose `sysio.roa` tables answer from fixed rows. */
function wireWith(
  states: Partial<SysioContracts.SysioRoaRoaStateType>[],
  owners: Partial<SysioContracts.SysioRoaNodeownersType>[] = [],
  audits: Partial<SysioContracts.SysioRoaNodeownerregType>[] = []
) {
  const roastate = { query: jest.fn().mockResolvedValue({ rows: states, more: false }) },
    nodeowners = { queryAll: jest.fn().mockResolvedValue(owners) },
    nodeownerreg = { queryAll: jest.fn().mockResolvedValue(audits) },
    getSysioContract = jest.fn(() => ({ tables: { roastate, nodeowners, nodeownerreg } }))
  return { wire: { getSysioContract } as never, getSysioContract, nodeowners, nodeownerreg }
}

describe("WireNodeOwnerTool", () => {
  it("scopes every read by the live network generation", async () => {
    const { wire, getSysioContract, nodeowners, nodeownerreg } = wireWith(
      [{ network_gen: 2 }],
      [{ owner: "gova", tier: NodeOwnerTier.T1 }],
      [{ owner: "gova" }]
    )
    expect(await WireNodeOwnerTool.readNetworkGenerationScope(wire)).toBe("2")
    expect(await WireNodeOwnerTool.readNodeOwner(wire, "gova")).toEqual({
      owner: "gova",
      tier: NodeOwnerTier.T1
    })
    expect(await WireNodeOwnerTool.readNodeOwnerReg(wire, "gova")).toEqual({ owner: "gova" })
    await WireNodeOwnerTool.readTierNodeOwners(wire, NodeOwnerTier.T1)
    expect(getSysioContract).toHaveBeenCalledWith(SysioContracts.SysioContractName.roa)
    nodeowners.queryAll.mock.calls.forEach(([args]) => expect(args).toEqual({ scope: "2" }))
    expect(nodeownerreg.queryAll).toHaveBeenCalledWith({ scope: "2" })
  })

  it("answers absent for an owner with no row", async () => {
    const { wire } = wireWith([{ network_gen: 0 }], [{ owner: "govb", tier: NodeOwnerTier.T1 }])
    expect(await WireNodeOwnerTool.readNodeOwner(wire, "gova")).toBeUndefined()
    expect(await WireNodeOwnerTool.readNodeOwnerReg(wire, "gova")).toBeUndefined()
  })

  it("refuses to read before ROA is activated", async () => {
    const { wire, nodeowners } = wireWith([])
    await expect(WireNodeOwnerTool.readNodeOwner(wire, "gova")).rejects.toThrow(
      /no roastate row: ROA is not activated/
    )
    expect(nodeowners.queryAll).not.toHaveBeenCalled()
  })

  describe("readTierNodeOwners", () => {
    it("lists the tier's owners of the live generation in chain name order", async () => {
      const { wire } = wireWith(
        [{ network_gen: 2 }],
        [
          { owner: "govc", tier: NodeOwnerTier.T1 },
          { owner: "govd", tier: NodeOwnerTier.T1 },
          { owner: "nodetwo", tier: NodeOwnerTier.T2 },
          { owner: "gova", tier: NodeOwnerTier.T1 }
        ]
      )
      expect(await WireNodeOwnerTool.readTierNodeOwners(wire, NodeOwnerTier.T1)).toEqual([
        "gova",
        "govc",
        "govd"
      ])
    })

    it("is empty when no owner of the tier is registered", async () => {
      const { wire } = wireWith([{ network_gen: 0 }], [{ owner: "nodetwo", tier: NodeOwnerTier.T2 }])
      expect(await WireNodeOwnerTool.readTierNodeOwners(wire, NodeOwnerTier.T1)).toEqual([])
    })
  })
})
