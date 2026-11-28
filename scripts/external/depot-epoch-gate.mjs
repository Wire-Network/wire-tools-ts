/**
 * The depot epoch gate of `verify-external-bind-config.mjs`: read every outpost chain's
 * `sysio.epoch::epochstate` row through `clio` in the depot container, take the lowest chain's
 * epoch index, and keep every idle chain due while the gate waits — the script-side twin of the
 * harness's keep-due pump (`EpochAdvanceSteps.keepChainsDue`).
 *
 * Epochs are depot-paced: a chain advances only once it has traffic and its minimum duration has
 * passed, so a resumed cluster with nothing queued never advances by itself. The gate gives an
 * idle chain traffic with `sysio.epoch::notetraffic` (traffic since now), declared by
 * `sysio.msgch@active` — the account the action requires — whose authority is `sysio@active`.
 * The push is signed by the kiod wallet `wire-cluster-tool run` unlocked in the depot container,
 * so that wallet must hold the key behind `sysio@active` (the cluster's initial key on a cluster
 * `create` made locally; a cluster whose governance was handed off cannot be gated this way).
 * `notetraffic` leaves `rostersent` alone, so the gate never re-ships a roster.
 *
 * Every read and push goes through an injected {@link DepotClio}, so the module is testable
 * without Docker. Not executable itself; `verify-external-bind-config.mjs` imports it.
 */

import { chalk, echo } from "zx"

import {
  chainEpochStates,
  chainsToKeepDue,
  EpochStateRowLimit,
  lowestChainEpochIndex
} from "../common/epoch-state.mjs"

/**
 * One `clio` run in the depot container: its exit code and output streams.
 *
 * @typedef {{ exitCode: number, stdout: string, stderr: string }} DepotClioResult
 */

/**
 * Runs `clio` in the depot container against the depot producer with `args` (everything after
 * `-u <url>`), never throwing on a non-zero exit.
 *
 * @typedef {(args: string[]) => Promise<DepotClioResult>} DepotClio
 */

/** The depot contract that owns every chain's consensus epoch. */
export const SysioEpochAccount = "sysio.epoch"

/** The per-chain consensus state table the gate reads. */
export const EpochStateTable = "epochstate"

/** The `sysio.epoch` action that gives a chain traffic. */
export const NotetrafficAction = "notetraffic"

/**
 * The authority `sysio.epoch::notetraffic` is declared with: `sysio.msgch@active`, the account the
 * action requires, whose authority is `sysio@active`.
 */
export const NotetrafficPermission = "sysio.msgch@active"

/** The `since` `notetraffic` reads as now: a zero `time_point`. */
export const TrafficSinceNow = "1970-01-01T00:00:00.000"

/**
 * Read every outpost chain's `sysio.epoch::epochstate` row, keyed by codename
 * ({@link chainEpochStates}). v6 promoted `epochstate` to a KV table — the fields live under
 * `.value` (see cluster-state-active-probing.md).
 *
 * @param {DepotClio} clio the depot-container clio runner.
 * @return {Promise<Record<string, object> | null>} each chain's row, or null when the read fails
 *   or its output does not parse.
 */
export async function readDepotEpochStates(clio) {
  try {
    const result = await clio([
      "get", "table", SysioEpochAccount, EpochStateTable, "-S", SysioEpochAccount, "-l", String(EpochStateRowLimit)
    ])
    if (result.exitCode !== 0) return null
    return chainEpochStates(JSON.parse(result.stdout).rows ?? [])
  } catch (error) {
    echo(chalk.dim(`epochstate read failed: ${error instanceof Error ? error.message : String(error)}`))
    return null
  }
}

/**
 * One gate reading: the LOWEST `current_epoch_index` of the expected chains (each runs its own
 * depot-paced epoch, so the gate advances only once every one has) and, from the SAME snapshot,
 * the chains idle at that moment ({@link chainsToKeepDue}). The gate pumps only those, and only
 * when the reading leaves it unsatisfied, so a chain that advanced after the read is never given
 * traffic on a stale view.
 *
 * @param {DepotClio} clio the depot-container clio runner.
 * @param {string[]} expectedChains the chains the gate waits on.
 * @return {Promise<{ index: number | null, idleChains: string[] } | null>} the reading (its index
 *   null while an expected chain has no row), or null when the read fails.
 */
export async function readDepotEpoch(clio, expectedChains) {
  const states = await readDepotEpochStates(clio)
  if (states == null) return null
  return {
    index: lowestChainEpochIndex(states, expectedChains),
    idleChains: chainsToKeepDue(states, expectedChains)
  }
}

/**
 * Give each of `chains` traffic: one `sysio.epoch::notetraffic` (traffic since now) per chain,
 * declared by {@link NotetrafficPermission} and signed through the kiod wallet at `walletUrl`,
 * so the chain is due within one minimum duration. A refused push (the wallet lacks the key behind
 * `sysio@active`, or the chain moved on) is printed and retried on the next poll.
 *
 * @param {DepotClio} clio the depot-container clio runner.
 * @param {string[]} chains the idle chains ({@link readDepotEpoch}'s `idleChains`).
 * @param {string} walletUrl the depot kiod wallet URL `wire-cluster-tool run` unlocked.
 * @return {Promise<string[]>} the chains whose push succeeded.
 */
export async function keepDepotChainsDue(clio, chains, walletUrl) {
  const pushed = []
  for (const chain of chains) {
    const result = await clio([
      "--wallet-url", walletUrl,
      "push", "action", SysioEpochAccount, NotetrafficAction,
      JSON.stringify({ chain_code: chain, since: TrafficSinceNow }),
      "-p", NotetrafficPermission
    ])
    if (result.exitCode === 0) pushed.push(chain)
    echo(
      result.exitCode === 0
        ? chalk.dim(`  ${chain} is idle: notetraffic gives it traffic`)
        : chalk.yellow(`  ${chain} notetraffic refused (retried next poll): ${result.stderr.trim()}`)
    )
  }
  return pushed
}
