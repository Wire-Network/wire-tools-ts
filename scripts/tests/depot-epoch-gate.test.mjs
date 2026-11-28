import Assert from "node:assert/strict"
import { test } from "node:test"

import { EpochStateRowLimit } from "../common/epoch-state.mjs"
import {
  EpochStateTable,
  keepDepotChainsDue,
  NotetrafficAction,
  NotetrafficPermission,
  readDepotEpoch,
  readDepotEpochStates,
  SysioEpochAccount,
  TrafficSinceNow
} from "../external/depot-epoch-gate.mjs"

/** A packed slug_name chain code, as a per-chain `sysio.epoch` row renders it. */
const EthereumCode = 23373300651341
const SolanaCode = 84606581215232

/** A zero `time_point`: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/** The depot kiod wallet URL the fixtures sign through. */
const WalletUrl = "http://depot:8900"

/** One chain's v6 KV `epochstate` row: at `index`, idle unless `dueAt` is set, paused or not. */
function epochRow(code, index, dueAt = NoTraffic, isPaused = false) {
  return {
    key: { chain_code: code },
    value: { chain_code: code, current_epoch_index: index, due_at: dueAt, is_paused: isPaused }
  }
}

/**
 * A {@link import("../external/depot-epoch-gate.mjs").DepotClio} answering every call with the
 * next of `results` (the last repeats), recording each call's args.
 */
function scriptedClio(...results) {
  const calls = []
  const clio = async args => {
    calls.push(args)
    return results.length > 1 ? results.shift() : results[0]
  }
  return { clio, calls }
}

/** A successful `get table` result carrying `rows`. */
function tableResult(rows) {
  return { exitCode: 0, stdout: JSON.stringify({ rows, more: false }), stderr: "" }
}

test("readDepotEpochStates reads every chain's epochstate row in one bounded get table, keyed by codename", async () => {
  const { clio, calls } = scriptedClio(tableResult([epochRow(EthereumCode, 4), epochRow(SolanaCode, 2)]))
  const states = await readDepotEpochStates(clio)
  Assert.deepEqual(Object.keys(states).sort(), ["ETHEREUM", "SOLANA"])
  Assert.equal(states.ETHEREUM.current_epoch_index, 4)
  Assert.deepEqual(calls, [
    ["get", "table", SysioEpochAccount, EpochStateTable, "-S", SysioEpochAccount, "-l", String(EpochStateRowLimit)]
  ])
})

test("readDepotEpochStates is null on a failed clio or output that does not parse", async () => {
  Assert.equal(await readDepotEpochStates(scriptedClio({ exitCode: 1, stdout: "", stderr: "refused" }).clio), null)
  Assert.equal(await readDepotEpochStates(scriptedClio({ exitCode: 0, stdout: "not json", stderr: "" }).clio), null)
})

test("readDepotEpoch reads the lowest chain's index and, from the same snapshot, the idle unpaused chains", async () => {
  const { clio } = scriptedClio(
    tableResult([
      epochRow(EthereumCode, 7, "2026-11-25T00:01:00.000"),
      epochRow(SolanaCode, 3)
    ])
  )
  Assert.deepEqual(await readDepotEpoch(clio, ["ETHEREUM", "SOLANA"]), { index: 3, idleChains: ["SOLANA"] })
  const paused = scriptedClio(tableResult([epochRow(EthereumCode, 7), epochRow(SolanaCode, 3, NoTraffic, true)]))
  Assert.deepEqual(await readDepotEpoch(paused.clio, ["ETHEREUM", "SOLANA"]), { index: 3, idleChains: ["ETHEREUM"] })
})

test("readDepotEpoch reads no index while an expected chain has no row, and null when unreachable", async () => {
  const { clio } = scriptedClio(tableResult([epochRow(EthereumCode, 7)]))
  Assert.deepEqual(await readDepotEpoch(clio, ["ETHEREUM", "SOLANA"]), { index: null, idleChains: ["ETHEREUM"] })
  Assert.equal(await readDepotEpoch(scriptedClio({ exitCode: 1, stdout: "", stderr: "" }).clio, ["ETHEREUM"]), null)
})

test("keepDepotChainsDue pushes one notetraffic since now per chain, declared by sysio.msgch@active through the wallet", async () => {
  const { clio, calls } = scriptedClio({ exitCode: 0, stdout: "{}", stderr: "" })
  Assert.deepEqual(await keepDepotChainsDue(clio, ["ETHEREUM", "SOLANA"], WalletUrl), ["ETHEREUM", "SOLANA"])
  Assert.equal(NotetrafficPermission, "sysio.msgch@active")
  Assert.deepEqual(calls, ["ETHEREUM", "SOLANA"].map(chain => [
    "--wallet-url", WalletUrl,
    "push", "action", SysioEpochAccount, NotetrafficAction,
    JSON.stringify({ chain_code: chain, since: TrafficSinceNow }),
    "-p", NotetrafficPermission
  ]))
  Assert.equal(TrafficSinceNow, NoTraffic)
})

test("keepDepotChainsDue reports only the pushes that landed, and pushes nothing for no chains", async () => {
  const { clio } = scriptedClio(
    { exitCode: 1, stdout: "", stderr: "missing authority of sysio.msgch" },
    { exitCode: 0, stdout: "{}", stderr: "" }
  )
  Assert.deepEqual(await keepDepotChainsDue(clio, ["ETHEREUM", "SOLANA"], WalletUrl), ["SOLANA"])
  const idle = scriptedClio({ exitCode: 0, stdout: "{}", stderr: "" })
  Assert.deepEqual(await keepDepotChainsDue(idle.clio, [], WalletUrl), [])
  Assert.equal(idle.calls.length, 0)
})
