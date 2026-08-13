import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { WireReserveTool } from "../../tools/wire/WireReserveTool.js"
import { slugValue } from "../../utils/slugUtils.js"

const { SysioContractName } = SysioContracts

/**
 * One reserve row's `(chain, wire)` book. Re-exported from
 * {@link WireReserveTool} — the AMM math and the scenario reads must agree on
 * one book shape, and the math owns it.
 */
export type ReserveBook = WireReserveTool.ReserveBook

/** The source + destination books snapshotted around a swap phase. */
export interface Books {
  src: ReserveBook
  dst: ReserveBook
}

/** One reserve's owner-fee rate and the revenue it has earned. */
export interface ReserveOwnerFee {
  /** The WIRE account that owns the reserve and may claim its fees. */
  owner: string
  /** The reserve's configured owner fee, in basis points. */
  feeBps: number
  /** Unclaimed WIRE held in `sysio.reserv` custody for the owner. */
  accrued: bigint
  /** Monotonic audit total — every WIRE this reserve has ever earned. */
  lifetime: bigint
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
      wire: BigInt(row.reserve_wire_amount),
      connectorWeightBps: Number(row.connector_weight_bps),
      ownerFeeBps: Number(row.owner_fee_bps)
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

  /**
   * One reserve's owner-fee state (a read) — its configured rate plus the
   * revenue it has earned. `accrued` is unclaimed WIRE sitting in
   * `sysio.reserv` custody until the owner calls `claimrsvfee`; `lifetime` is
   * the monotonic audit total a claim never reduces.
   *
   * @param chainCode - The reserve's chain slug value.
   * @param tokenCode - The reserve's token slug value.
   * @param reserveCode - The reserve's own slug value.
   * @returns The reserve's owner, fee rate, and earned/unclaimed amounts.
   * @throws When no reserve row matches the triple.
   */
  async reserveOwnerFee(
    chainCode: number,
    tokenCode: number,
    reserveCode: number
  ): Promise<ReserveOwnerFee> {
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
      owner: row.owner,
      feeBps: Number(row.owner_fee_bps),
      accrued: BigInt(row.owner_fee_accrued),
      lifetime: BigInt(row.owner_fee_lifetime)
    }
  }

  /**
   * An underwriter's accrued swap-fee row (`sysio.reserv::uwfees`) — the
   * underwriter half of every WIRE-leg fee their winning commits settled,
   * held in `sysio.reserv` custody until that account calls `claimuwfee`
   * (a read).
   *
   * @param underwriter - The underwriter's WIRE account name.
   * @returns The matching `uwfees` row, or nothing when the account has never
   *   won a swap (no row exists until the first accrual).
   */
  async underwriterFees(
    underwriter: string
  ): Promise<SysioContracts.SysioReservUwFeeRowType> {
    const { rows } = await this.wire
      .getSysioContract(SysioContractName.reserv)
      .tables.uwfees.query()
    return rows.find(row => row.underwriter === underwriter)
  }
}
