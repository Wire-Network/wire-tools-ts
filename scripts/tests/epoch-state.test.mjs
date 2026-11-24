import Assert from "node:assert/strict"
import { test } from "node:test"

import {
  chainCodename,
  chainEpochConfigs,
  chainEpochDurations,
  chainEpochStates,
  EpochStateRowLimit,
  kvRowValue,
  lowestChainEpochIndex
} from "../common/epoch-state.mjs"

/** A packed slug_name chain code, as a per-chain `sysio.epoch` row renders it. */
const EthereumCode = 23373300651341
const SolanaCode = 84606581215232

test("the per-chain read ceiling covers more than the outpost chains", () => {
  Assert.ok(Number.isInteger(EpochStateRowLimit) && EpochStateRowLimit > 2)
})

test("a v6 KV row unwraps to its value; a flat row is its own fields", () => {
  Assert.deepEqual(kvRowValue({ key: { chain_code: 1 }, value: { chain_code: 1, x: 2 } }), { chain_code: 1, x: 2 })
  Assert.deepEqual(kvRowValue({ chain_code: 1 }), { chain_code: 1 })
  Assert.equal(kvRowValue(null), null)
})

test("a chain code decodes from a number or a quoted decimal to its codename", () => {
  Assert.equal(chainCodename(EthereumCode), "ETHEREUM")
  Assert.equal(chainCodename(String(SolanaCode)), "SOLANA")
})

test("a chain code that is not an unsigned integer, or packs no codename, names no chain", () => {
  ;["ETHEREUM", "12abc", -1, 1.5, Number.NaN, null, undefined, 0, "0"].forEach(carrier =>
    Assert.equal(chainCodename(carrier), null, `chain_code ${String(carrier)}`)
  )
})

test("epochstate rows are keyed by their chain's codename, decoded from the packed code", () => {
  const states = chainEpochStates([
    { key: { chain_code: EthereumCode }, value: { chain_code: EthereumCode, current_epoch_index: 4 } },
    { chain_code: String(SolanaCode), current_epoch_index: "2", is_paused: true }
  ])
  Assert.deepEqual(Object.keys(states).sort(), ["ETHEREUM", "SOLANA"])
  Assert.equal(states.ETHEREUM.current_epoch_index, 4)
  Assert.equal(states.SOLANA.current_epoch_index, 2)
  Assert.equal(states.SOLANA.is_paused, true)
})

test("epochstate rows that do not decode are dropped, never keyed by an empty codename", () => {
  const states = chainEpochStates([
    { value: { chain_code: EthereumCode } },
    { chain_code: "not-a-number", current_epoch_index: 3 },
    { chain_code: 0, current_epoch_index: 3 },
    { chain_code: SolanaCode, current_epoch_index: "x" }
  ])
  Assert.deepEqual(states, {})
})

test("epochcfg rows are keyed by chain with a numeric epoch duration", () => {
  const configs = chainEpochConfigs([
    { value: { chain_code: EthereumCode, epoch_duration_sec: "60" } },
    { chain_code: SolanaCode, epoch_duration_sec: 150 },
    { chain_code: "bogus", epoch_duration_sec: 90 },
    { chain_code: EthereumCode }
  ])
  Assert.deepEqual(Object.keys(configs).sort(), ["ETHEREUM", "SOLANA"])
  Assert.equal(configs.ETHEREUM.epoch_duration_sec, 60)
  Assert.equal(configs.SOLANA.epoch_duration_sec, 150)
})

test("a cluster config's chain durations are its outpostEpochDurationSec, else none", () => {
  Assert.deepEqual(chainEpochDurations({ epochDurationSec: 60, outpostEpochDurationSec: { ETHEREUM: 60, SOLANA: 150 } }), {
    ETHEREUM: 60,
    SOLANA: 150
  })
  Assert.deepEqual(chainEpochDurations({ epochDurationSec: 90 }), {})
  Assert.deepEqual(chainEpochDurations(null), {})
})

test("the epoch gate reads the lowest index once every expected chain has a row", () => {
  const states = { ETHEREUM: { current_epoch_index: 7 }, SOLANA: { current_epoch_index: 3 } }
  Assert.equal(lowestChainEpochIndex(states, ["ETHEREUM", "SOLANA"]), 3)
  Assert.equal(lowestChainEpochIndex(states, ["ETHEREUM"]), 7)
})

test("the epoch gate reads null while an expected chain has no row, or none is expected", () => {
  const ethereumOnly = { ETHEREUM: { current_epoch_index: 7 } }
  Assert.equal(lowestChainEpochIndex(ethereumOnly, ["ETHEREUM", "SOLANA"]), null)
  Assert.equal(lowestChainEpochIndex(ethereumOnly, []), null)
  Assert.equal(lowestChainEpochIndex(null, ["ETHEREUM"]), null)
})
