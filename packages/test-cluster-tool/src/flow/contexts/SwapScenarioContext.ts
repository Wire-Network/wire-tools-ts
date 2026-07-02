import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { slugValue } from "../../utils/slugUtils.js"

const { SysioContractName } = SysioContracts

/** One reserve row's `(chain, wire)` book. */
export interface ReserveBook {
  chain: bigint
  wire: bigint
}

/** The source + destination books snapshotted around a swap phase. */
export interface Books {
  src: ReserveBook
  dst: ReserveBook
}

/**
 * Shared scenario context for the swap flows — the depot-side query surface
 * every swap direction reads: reserve books (`sysio.reserv::reserves`), the
 * underwrite request for a chain pair (`sysio.uwrit::uwreqs`), and the lock
 * vector backing a request (`sysio.uwrit::locks`). All reads go through the
 * typed contract table accessors; scenarios subclass this (or use it directly)
 * and call the helpers from verify-step runners.
 */
export class SwapScenarioContext extends ClusterBuildContext {
  /**
   * One reserve row's `(chain, wire)` book by its slug triple (a read).
   *
   * @param chainCode - The reserve's chain slug value.
   * @param tokenCode - The reserve's token slug value.
   * @param reserveCode - The reserve's own slug value.
   * @returns The reserve's chain-side + WIRE-side book amounts.
   * @throws When no reserve row matches the triple.
   */
  async reserveBook(
    chainCode: number,
    tokenCode: number,
    reserveCode: number
  ): Promise<ReserveBook> {
    const { rows } = await this.wire
      .getSysioContract(SysioContractName.reserv)
      .tables.reserves.query()
    const row = rows.find(
      reserve =>
        slugValue(reserve.chain_code) === chainCode &&
        slugValue(reserve.token_code) === tokenCode &&
        slugValue(reserve.reserve_code) === reserveCode
    )
    Assert.ok(row, `reserve ${chainCode}/${tokenCode}/${reserveCode} not found`)
    return {
      chain: BigInt(row.reserve_chain_amount),
      wire: BigInt(row.reserve_wire_amount)
    }
  }

  /**
   * The underwrite request row for a `(source chain, destination chain)` pair
   * (a read).
   *
   * @param srcChainCode - The source chain slug value.
   * @param dstChainCode - The destination chain slug value.
   * @returns The matching `uwreqs` row, or nothing when the depot has not
   *   created one yet.
   */
  async uwreq(
    srcChainCode: number,
    dstChainCode: number
  ): Promise<SysioContracts.SysioUwritUwRequestTType> {
    const { rows } = await this.wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.uwreqs.query()
    return rows.find(
      request =>
        slugValue(request.src_chain_code) === srcChainCode &&
        slugValue(request.dst_chain_code) === dstChainCode
    )
  }

  /**
   * The locks backing an underwrite request (a read).
   *
   * @param uwreqId - The `uwreqs` row id.
   * @returns Every `locks` row referencing the request.
   */
  async locksForUwreq(
    uwreqId: number
  ): Promise<SysioContracts.SysioUwritLockEntryType[]> {
    const { rows } = await this.wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.locks.query()
    return rows.filter(lock => Number(lock.uwreq_id) === uwreqId)
  }
}
