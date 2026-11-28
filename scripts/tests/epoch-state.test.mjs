import Assert from "node:assert/strict"
import { test } from "node:test"

import {
  chainCodename,
  chainEpochConfigs,
  chainEpochDurations,
  chainEpochStates,
  chainOutpostConsensus,
  chainsToKeepDue,
  EpochStateRowLimit,
  isCurrentEpochDecided,
  isIdleChainState,
  kvRowValue,
  lowestChainEpochIndex,
  timePointMs
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

/** A zero `time_point`: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

test("a time_point parses as UTC with or without a zone suffix; zero is the epoch; junk is null", () => {
  Assert.equal(timePointMs("2026-10-01T00:00:00.000"), Date.UTC(2026, 9, 1))
  Assert.equal(timePointMs("2026-10-01T00:00:00.000Z"), Date.UTC(2026, 9, 1))
  Assert.equal(timePointMs("2026-10-01T02:00:00.000+02:00"), Date.UTC(2026, 9, 1))
  Assert.equal(timePointMs(NoTraffic), 0)
  ;["", "invalid", null, undefined, 5].forEach(cell => Assert.equal(timePointMs(cell), null))
})

test("a started chain with a zero due_at is idle; traffic, genesis or no row is not", () => {
  Assert.equal(isIdleChainState({ current_epoch_index: 3, due_at: NoTraffic }), true)
  Assert.equal(isIdleChainState({ current_epoch_index: 3, due_at: "2026-10-01T00:01:00.000" }), false)
  Assert.equal(isIdleChainState({ current_epoch_index: 0, due_at: NoTraffic }), false)
  Assert.equal(isIdleChainState(undefined), false)
})

test("a due_at that is absent or does not parse is unknown traffic, never idle", () => {
  Assert.equal(isIdleChainState({ current_epoch_index: 3 }), false)
  Assert.equal(isIdleChainState({ current_epoch_index: 3, due_at: "not a time" }), false)
  Assert.equal(isIdleChainState({ current_epoch_index: 3, due_at: 0 }), false)
  Assert.deepEqual(chainsToKeepDue({ ETHEREUM: { current_epoch_index: 3 } }, ["ETHEREUM"]), [])
})

test("outpcons rows are keyed by chain with a numeric decided epoch", () => {
  const consensus = chainOutpostConsensus([
    { key: { chain_code: EthereumCode }, value: { chain_code: EthereumCode, epoch_index: "4" } },
    { chain_code: SolanaCode, epoch_index: 2 },
    { chain_code: "bogus", epoch_index: 1 },
    { chain_code: EthereumCode }
  ])
  Assert.deepEqual(Object.keys(consensus).sort(), ["ETHEREUM", "SOLANA"])
  Assert.equal(consensus.ETHEREUM.epoch_index, 4)
  Assert.equal(consensus.SOLANA.epoch_index, 2)
})

test("a chain's current epoch is decided once outpcons records its winner, or a later one", () => {
  Assert.equal(isCurrentEpochDecided({ current_epoch_index: 4 }, { epoch_index: 4 }), true)
  Assert.equal(isCurrentEpochDecided({ current_epoch_index: 4 }, { epoch_index: 5 }), true)
  Assert.equal(isCurrentEpochDecided({ current_epoch_index: 4 }, { epoch_index: 3 }), false)
  Assert.equal(isCurrentEpochDecided({ current_epoch_index: 1 }, undefined), false)
  Assert.equal(isCurrentEpochDecided(undefined, { epoch_index: 3 }), false)
})

test("the gate keeps due every expected idle, unpaused chain and no other", () => {
  const states = {
    ETHEREUM: { current_epoch_index: 3, due_at: NoTraffic },
    SOLANA: { current_epoch_index: 5, due_at: NoTraffic, is_paused: true }
  }
  Assert.deepEqual(chainsToKeepDue(states, ["ETHEREUM", "SOLANA"]), ["ETHEREUM"])
  Assert.deepEqual(chainsToKeepDue({ ...states, SOLANA: { current_epoch_index: 5, due_at: NoTraffic } }, ["SOLANA", "ETHEREUM"]), [
    "SOLANA",
    "ETHEREUM"
  ])
  Assert.deepEqual(chainsToKeepDue({ ETHEREUM: { current_epoch_index: 3, due_at: "2026-10-01T00:01:00.000" } }, ["ETHEREUM"]), [])
  Assert.deepEqual(chainsToKeepDue({}, ["ETHEREUM"]), [])
})
