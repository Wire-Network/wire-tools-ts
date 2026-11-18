import { SysioContracts } from "@wireio/sdk-core"
import type { NodeOwnerTier } from "@wireio/opp-typescript-models"
import type { WireClient } from "../../clients/wire/WireClient.js"
import { WireSysioContractTool } from "./WireSysioContractTool.js"

const { SysioContractName } = SysioContracts

/**
 * Reads of the depot's node-owner registry (`sysio.roa`). `nodeowners` and its
 * `nodeownerreg` audit are scoped by network generation, and every read here
 * scopes them by the LIVE generation, `roastate.network_gen`.
 */
export namespace WireNodeOwnerTool {
  /**
   * The live network generation, the scope of `nodeowners` and `nodeownerreg`.
   *
   * @param wire - The WIRE client.
   * @returns `roastate.network_gen`, as a table scope.
   * @throws When `sysio.roa` holds no `roastate` row (ROA is not activated).
   */
  export async function readNetworkGenerationScope(wire: WireClient): Promise<string> {
    const {
      rows: [state]
    } = await wire.getSysioContract(SysioContractName.roa).tables.roastate.query()
    if (state == null)
      throw new Error(
        "sysio.roa holds no roastate row: ROA is not activated, so there is no network generation"
      )
    return String(state.network_gen)
  }

  /**
   * The `nodeownerreg` audit row for `owner` in the live generation, or absent.
   *
   * @param wire - The WIRE client.
   * @param owner - The node-owner account.
   * @returns The audit row, or `undefined` when the owner has none.
   */
  export async function readNodeOwnerReg(
    wire: WireClient,
    owner: string
  ): Promise<SysioContracts.SysioRoaNodeownerregType> {
    const rows = await wire
      .getSysioContract(SysioContractName.roa)
      .tables.nodeownerreg.queryAll({ scope: await readNetworkGenerationScope(wire) })
    return rows.find(row => row.owner === owner)
  }

  /**
   * The `nodeowners` registration row for `owner` in the live generation, or absent.
   *
   * @param wire - The WIRE client.
   * @param owner - The node-owner account.
   * @returns The registration row, or `undefined` when the owner is not registered.
   */
  export async function readNodeOwner(
    wire: WireClient,
    owner: string
  ): Promise<SysioContracts.SysioRoaNodeownersType> {
    const rows = await wire
      .getSysioContract(SysioContractName.roa)
      .tables.nodeowners.queryAll({ scope: await readNetworkGenerationScope(wire) })
    return rows.find(row => row.owner === owner)
  }

  /**
   * The registered node owners of `tier` in the live generation, in chain
   * name-value order — the roster `sysio.councl::syncnodes` writes for tier 1.
   *
   * @param wire - The WIRE client.
   * @param tier - The tier to list.
   * @returns The owners, ascending by name value.
   */
  export async function readTierNodeOwners(
    wire: WireClient,
    tier: NodeOwnerTier
  ): Promise<string[]> {
    const rows = await wire
      .getSysioContract(SysioContractName.roa)
      .tables.nodeowners.queryAll({ scope: await readNetworkGenerationScope(wire) })
    return rows
      .filter(row => Number(row.tier) === tier)
      .map(row => row.owner)
      .sort(WireSysioContractTool.compareNames)
  }
}
