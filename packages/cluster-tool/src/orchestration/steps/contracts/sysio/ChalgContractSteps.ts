import Assert from "node:assert"

import { SlugName, SysioContracts } from "@wireio/sdk-core"

import type { Constants } from "../../../../Constants.js"
import { matchesProtoEnum } from "../../../../utils/predicateUtils.js"
import { isPackedCode } from "../../../../utils/slugUtils.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"

const { SysioChalgDisputestatus, SysioContractName } = SysioContracts

/**
 * Reads of `sysio.chalg` (OPP envelope disputes). Its actions are `sysio.msgch`'s, the Tier-1
 * electorate's and the permissionless crank's; the harness only reads the disputes they leave.
 */
export namespace ChalgContractSteps {
  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * Row ceiling of the whole-table `disputes` read ({@link readDisputes}). A resolved dispute stays as
   * its audit row, so the table only grows; a read that still reports `more` is refused rather than
   * trusted. A read of one epoch's dispute ({@link readEpochDispute}) does not depend on it.
   */
  export const DisputeRowLimit = 100

  /** The `disputes` secondary index keyed by (outpost chain, epoch), which holds one dispute per pair. */
  export const OutpostEpochIndex = "byoutepoch"

  /** Bits of an {@link outpostEpochKey} below the chain's packed code: the epoch index's. */
  const EpochIndexBits = 32n

  /**
   * The `byoutepoch` key of `chain`'s epoch `epochIndex` — pure: the chain's packed code above the
   * epoch index's 32 bits (`opp::outpost_epoch_key`).
   *
   * @param chain - The outpost chain.
   * @param epochIndex - The chain's consensus epoch.
   * @returns The 128-bit key.
   */
  export function outpostEpochKey(chain: Constants.OutpostChainCodename, epochIndex: number): bigint {
    return (BigInt(SlugName.from(chain)) << EpochIndexBits) | BigInt(epochIndex)
  }

  /**
   * READ the dispute on `chain`'s epoch `epochIndex`, open or resolved, through the
   * {@link OutpostEpochIndex} index: one row however many disputes the table holds.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @param epochIndex - The chain's consensus epoch.
   * @returns The epoch's dispute (absent when the epoch was never disputed).
   */
  export async function readEpochDispute<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename,
    epochIndex: number
  ): Promise<SysioContracts.SysioChalgDisputeEntryType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .tables.disputes.query({
        indexName: OutpostEpochIndex,
        lowerBound: JSON.stringify({ [OutpostEpochIndex]: outpostEpochKey(chain, epochIndex).toString() }),
        limit: 1
      })
    // The read starts at the key, so a row it returns past the key is a later epoch's or chain's.
    return rows.find(row => isDisputeOf(row, chain, epochIndex))
  }

  /**
   * Every `sysio.chalg::disputes` row from ONE read, open and resolved.
   *
   * @param ctx - The build context.
   * @returns The dispute rows.
   * @throws When the read is truncated at {@link DisputeRowLimit}.
   */
  export async function readDisputes<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioChalgDisputeEntryType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .tables.disputes.query({ limit: DisputeRowLimit })
    Assert.ok(
      !more,
      `ChalgContractSteps: sysio.chalg::disputes has more than ${DisputeRowLimit} rows; the read is truncated`
    )
    return rows
  }

  /**
   * Whether a dispute row disputes `chain`'s epoch `epochIndex` — pure. Each chain counts its own
   * epochs, so the row is matched on the chain as well as the epoch.
   *
   * @param row - A `disputes` row.
   * @param chain - The outpost chain.
   * @param epochIndex - The chain's consensus epoch.
   * @returns True when the row disputes that epoch, open or resolved.
   * @throws If the row's chain cell is not a packed code (a slug spelling is refused, not misread).
   */
  export function isDisputeOf(
    row: SysioContracts.SysioChalgDisputeEntryType,
    chain: Constants.OutpostChainCodename,
    epochIndex: number
  ): boolean {
    return isPackedCode(row.chain_code, chain) && Number(row.epoch_index) === epochIndex
  }

  /**
   * Whether a dispute row is the OPEN dispute on `chain`'s epoch `epochIndex` — pure.
   *
   * @param row - A `disputes` row.
   * @param chain - The outpost chain.
   * @param epochIndex - The chain's consensus epoch.
   * @returns True when the row disputes that epoch and is still open.
   */
  export function isOpenDispute(
    row: SysioContracts.SysioChalgDisputeEntryType,
    chain: Constants.OutpostChainCodename,
    epochIndex: number
  ): boolean {
    return (
      isDisputeOf(row, chain, epochIndex) &&
      matchesProtoEnum(row.status, SysioChalgDisputestatus, SysioChalgDisputestatus.DISPUTE_STATUS_OPEN)
    )
  }
}
