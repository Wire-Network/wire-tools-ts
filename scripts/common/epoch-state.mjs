/**
 * Helpers shared by the scripts that read the depot's per-chain consensus epoch tables
 * (`sysio.epoch::epochstate` and `sysio.epoch::epochcfg`, one row per outpost chain): the
 * read's row ceiling, the v6 KV row unwrap, the decode that keys each table's rows by their
 * chain's codename, the chain set a cluster config names, and the epoch gate's lowest-chain
 * index.
 *
 * Not executable itself; scripts import it as `./common/epoch-state.mjs` (or
 * `../common/epoch-state.mjs` from a subdirectory).
 */

import { SlugName, UInt64 } from "@wireio/sdk-core"

/**
 * Row ceiling of a per-chain epoch table read (`epochstate`, `epochcfg`): the tables hold one
 * row per outpost chain. Raising it only widens the read; lowering it below the chain count
 * drops chains from every probe.
 */
export const EpochStateRowLimit = 16

/**
 * The decoded codename of a `chain_code` that does not decode — a packed value of 0 renders as
 * the empty slug, which names no chain.
 */
const UndecodedCodename = ""

/**
 * v6 KV rows arrive as `{key, value}` — the fields live under `.value`; fall back to the row
 * itself for non-KV shapes.
 *
 * @param {object} row a `get table` row.
 * @return {object} the field-carrying object.
 */
export function kvRowValue(row) {
  return row?.value ?? row
}

/**
 * The codename of a per-chain row's `chain_code`: the chain's packed `uint64` slug (a JSON
 * number, or a quoted decimal past 2^32), decoded through sdk-core's `UInt64` and `SlugName`.
 *
 * @param {unknown} chainCode the row's `chain_code` cell.
 * @return {string | null} the chain's codename, or null when the cell is not an unsigned
 *   integer or packs no codename.
 */
export function chainCodename(chainCode) {
  try {
    const codename = SlugName.toString(UInt64.from(chainCode).toNumber())
    return codename === UndecodedCodename ? null : codename
  } catch {
    return null // not an unsigned integer carrier: the row names no chain
  }
}

/**
 * Key per-chain rows by their chain's codename, with `numericField` read as a number. A row
 * whose `chain_code` does not decode ({@link chainCodename}) or whose `numericField` is not
 * numeric is dropped.
 *
 * @param {object[]} rows the `get table` rows (v6 `{key, value}` or flat).
 * @param {string} numericField the field every kept row carries as a number.
 * @return {Record<string, object>} each chain's row, by codename.
 */
function keyRowsByChain(rows, numericField) {
  return Object.fromEntries(
    rows
      .map(kvRowValue)
      .map(row => ({ row, codename: chainCodename(row?.chain_code) }))
      .filter(({ row, codename }) => codename != null && Number.isFinite(Number(row?.[numericField])))
      .map(({ row, codename }) => [codename, { ...row, [numericField]: Number(row[numericField]) }])
  )
}

/**
 * Key `sysio.epoch::epochstate` rows by their chain's codename — each chain's own consensus
 * epoch: index, start / next timestamps and pause flag.
 *
 * @param {object[]} rows the `get table` rows (v6 `{key, value}` or flat).
 * @return {Record<string, object>} each chain's row, `current_epoch_index` a number; rows that
 *   do not decode are dropped.
 */
export function chainEpochStates(rows) {
  return keyRowsByChain(rows, "current_epoch_index")
}

/**
 * Key `sysio.epoch::epochcfg` rows by their chain's codename — each chain's consensus epoch
 * config, the depot's source of truth for its epoch duration once its `setconfig` ran.
 *
 * @param {object[]} rows the `get table` rows (v6 `{key, value}` or flat).
 * @return {Record<string, object>} each chain's row, `epoch_duration_sec` a number; rows that
 *   do not decode are dropped.
 */
export function chainEpochConfigs(rows) {
  return keyRowsByChain(rows, "epoch_duration_sec")
}

/**
 * Each outpost chain's epoch duration a cluster config names: its `outpostEpochDurationSec`
 * (the value its bootstrap writes to the chain's `epochcfg` row); empty for a config that names
 * none.
 *
 * @param {object} config the parsed cluster-config.json.
 * @return {Record<string, number>} each named chain's duration in seconds, by codename.
 */
export function chainEpochDurations(config) {
  return config?.outpostEpochDurationSec ?? {}
}

/**
 * The epoch gate's index: the LOWEST `current_epoch_index` across the expected outpost chains,
 * since each chain runs its own consensus epoch and the network has advanced only once every
 * one has. Null until every expected chain has a row, so a chain that never started can never
 * be passed over.
 *
 * @param {Record<string, object>} states each chain's epoch row ({@link chainEpochStates}).
 * @param {string[]} expectedChains the chains that must each have a row.
 * @return {number | null} the lowest chain's index, or null while any expected chain has no
 *   row (or none is expected).
 */
export function lowestChainEpochIndex(states, expectedChains) {
  return expectedChains.length === 0 || expectedChains.some(chain => states?.[chain] == null)
    ? null
    : Math.min(...expectedChains.map(chain => states[chain].current_epoch_index))
}
