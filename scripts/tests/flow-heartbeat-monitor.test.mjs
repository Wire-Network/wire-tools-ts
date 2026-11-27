import Assert from "node:assert/strict"
import Fs from "node:fs/promises"
import Os from "node:os"
import Path from "node:path"
import { test } from "node:test"

import {
  bootstrapBailReason,
  bootstrapDeadlineSeconds,
  chainEpochDurationSeconds,
  describeChainEpochs,
  isStallReprobeDue,
  monitoredChains,
  networkGrowthDeadlineMs,
  oppGrowthBailReason,
  probeAggregateLog,
  resolveChainEpochDurations,
  stallReprobeDueChains,
  stalledChain
} from "../flow-heartbeat-monitor.mjs"

async function probe(lines, expectFreeze) {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "wire-heartbeat-"))
  try {
    const filename = Path.join(directory, "cluster.log")
    await Fs.writeFile(filename, lines.join("\n") + "\n")
    return await probeAggregateLog(filename, expectFreeze)
  } finally {
    await Fs.rm(directory, { recursive: true, force: true })
  }
}

for (const reason of [
  "EnforcedPause()",
  "WIRE_NoPendingDesyndication(3)",
  "custom error 0xd93c0665",
  `custom error 0x287022ed: ${"\0".repeat(31)}\x03`
]) {
  test(`emergency-stop expected refusal is noise only with --expect-freeze: ${reason.split(":")[0]}`, async () => {
    const lines = [`    Error: Execution error: execution reverted: ${reason}`],
      expected = await probe(lines, true),
      ordinary = await probe(lines, false)
    Assert.equal(expected.fatalCount, 0)
    Assert.equal(expected.noiseCount, 1)
    Assert.equal(ordinary.fatalCount, 1)
    Assert.equal(ordinary.noiseCount, 0)
  })
}

test("consecutive expected recovery refusals do not grow the fatal count", async () => {
  const lines = [
    "Error: execution reverted: custom error 0xd93c0665",
    "Error: execution reverted: custom error 0x287022ed: request 2",
    "Error: execution reverted: custom error 0x287022ed: request 3"
  ]
  for (let count = 1; count <= lines.length; count++) {
    const result = await probe(lines.slice(0, count), true)
    Assert.equal(result.fatalCount, 0)
    Assert.equal(result.noiseCount, count)
  }
})

test("expected refusals preserve independent failures on the same line", async () => {
  for (const failure of ["execution reverted: unrelated failure", "batch_operator panicked"]) {
    const result = await probe([
      `Error: execution reverted: custom error 0x287022ed; ${failure}`
    ], true)
    Assert.equal(result.fatalCount, 1)
    Assert.equal(result.noiseCount, 1)
  }
})

test("unknown errors and longer selectors remain fatal under --expect-freeze", async () => {
  for (const reason of ["custom error 0xdeadbeef", "custom error 0xd93c06650", "custom error 0x287022eda", "OtherEnforcedPause"]) {
    const result = await probe([`Error: execution reverted: ${reason}`], true)
    Assert.equal(result.fatalCount, 1)
    Assert.equal(result.noiseCount, 0)
  }
})

test("Solana freeze refusal remains conditional on --expect-freeze", async () => {
  const lines = ["Program liqsol_core failed: custom program error: 0x17c7"],
    expected = await probe(lines, true),
    ordinary = await probe(lines, false)
  Assert.equal(expected.fatalCount, 0)
  Assert.equal(expected.noiseCount, 1)
  Assert.equal(ordinary.fatalCount, 1)
})

// ── per-chain consensus epochs ─────────────────────────────────────────────

/** The chains every per-chain fixture below runs, in codename order. */
const Chains = ["ETHEREUM", "SOLANA"]

test("a chain's duration is the override, else its configured duration, else the default", () => {
  const durations = { ETHEREUM: 60, SOLANA: 150 }
  Assert.equal(chainEpochDurationSeconds(durations, "SOLANA", null, 60), 150)
  Assert.equal(chainEpochDurationSeconds(durations, "SOLANA", 30, 60), 30)
  Assert.equal(chainEpochDurationSeconds({}, "ETHEREUM", null, 90), 90)
})

test("a chain's epochcfg duration supersedes its cluster-config duration once the row exists", () => {
  const configured = { ETHEREUM: 60, SOLANA: 150 }
  Assert.deepEqual(
    resolveChainEpochDurations(configured, { SOLANA: { epoch_duration_sec: 120 } }),
    { ETHEREUM: 60, SOLANA: 120 }
  )
  Assert.deepEqual(resolveChainEpochDurations(configured, {}), configured)
  // A chain the depot configured but the cluster config does not name still gets its row's duration.
  Assert.deepEqual(resolveChainEpochDurations({}, { ETHEREUM: { epoch_duration_sec: 45 } }), { ETHEREUM: 45 })
})

test("the watched chains are every configured chain and every chain with a depot row, sorted", () => {
  Assert.deepEqual(
    monitoredChains({ SOLANA: 150 }, { ETHEREUM: { epoch_duration_sec: 60 } }, { SOLANA: { current_epoch_index: 1 } }),
    Chains
  )
  Assert.deepEqual(monitoredChains({}, {}, {}), [])
})

test("the heartbeat lists every chain's epoch and marks only a boolean pause", () => {
  Assert.equal(
    describeChainEpochs({ ETHEREUM: { current_epoch_index: 4, is_paused: true }, SOLANA: { current_epoch_index: 2 } }, Chains),
    "ETHEREUM:4p,SOLANA:2"
  )
  Assert.equal(describeChainEpochs({ ETHEREUM: { current_epoch_index: 4, is_paused: 1 } }, ["ETHEREUM"]), "ETHEREUM:4")
  Assert.equal(describeChainEpochs({}, ["ETHEREUM"]), "ETHEREUM:?")
  Assert.equal(describeChainEpochs({}, []), "?")
})

test("the bootstrap deadline is the floor, the chain's epochs or the topology, whichever is longest", () => {
  Assert.equal(bootstrapDeadlineSeconds(5, 60), 300)
  Assert.equal(bootstrapDeadlineSeconds(5, 150), 450)
  Assert.equal(bootstrapDeadlineSeconds(21, 60), 1260)
})

test("the bootstrap bail names the first chain still unstarted past its own deadline", () => {
  const durations = { ETHEREUM: 60, SOLANA: 150 },
    duration = chain => durations[chain]
  // SOLANA's 150 s epochs give it a 450 s deadline; ETHEREUM's is the 300 s floor.
  const reason = bootstrapBailReason(Chains, { ETHEREUM: 0, SOLANA: 0 }, 301, 5, duration, 60)
  Assert.match(reason, /bootstrap never completed: ETHEREUM current_epoch_index=0 after 301s/)
  Assert.match(reason, /deadline 300s for 5 provisioned identities/)
  Assert.match(
    bootstrapBailReason(Chains, { ETHEREUM: 1, SOLANA: undefined }, 451, 5, duration, 60),
    /SOLANA current_epoch_index=null .*deadline 450s/
  )
  // A started chain never bails, and an unstarted one waits for its own deadline.
  Assert.equal(bootstrapBailReason(Chains, { ETHEREUM: 1, SOLANA: 0 }, 400, 5, duration, 60), null)
  Assert.equal(bootstrapBailReason(Chains, { ETHEREUM: 1, SOLANA: 1 }, 10_000, 5, duration, 60), null)
})

test("with no chain known, the bootstrap bail names the missing epochstate row on the default deadline", () => {
  const unused = () => Assert.fail("no chain may reach the per-chain duration")
  Assert.equal(bootstrapBailReason([], {}, 300, 5, unused, 60), null)
  const reason = bootstrapBailReason([], {}, 451, 5, unused, 150)
  Assert.match(reason, /bootstrap never completed: \(no epochstate row\) after 451s .*deadline 450s/)
  Assert.equal(bootstrapBailReason([], {}, 449, 5, unused, 150), null)
})

test("a stall re-probe waits for about two of the chain's own epochs", () => {
  // 60 s epochs: the first same-epoch beat (90 s) plus the 45 s re-probe passes 120 s.
  Assert.equal(isStallReprobeDue(90, 60), true)
  // 150 s epochs: two same-epoch beats are normal cadence; the third is due.
  Assert.equal(isStallReprobeDue(90, 150), false)
  Assert.equal(isStallReprobeDue(180, 150), false)
  Assert.equal(isStallReprobeDue(270, 150), true)
})

test("only chains at their previous epoch whose window is due are re-probed", () => {
  const durations = { ETHEREUM: 60, SOLANA: 150 },
    duration = chain => durations[chain],
    unchanged = () => 90
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 4, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, unchanged, duration),
    ["ETHEREUM"]
  )
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 5, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, () => 270, duration),
    ["SOLANA"]
  )
  // A chain this beat could not read is never due.
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: undefined, SOLANA: 2 }, { SOLANA: 3 }, unchanged, duration),
    []
  )
})

test("a re-probed chain still at its previous epoch is the stall; one that advanced is not", () => {
  const previous = { ETHEREUM: 4, SOLANA: 2 },
    beat = { ETHEREUM: 4, SOLANA: 2 }
  Assert.equal(
    stalledChain(Chains, { ETHEREUM: { current_epoch_index: 5 }, SOLANA: { current_epoch_index: 3 } }, beat, previous),
    undefined
  )
  Assert.equal(
    stalledChain(Chains, { ETHEREUM: { current_epoch_index: 5 }, SOLANA: { current_epoch_index: 2 } }, beat, previous),
    "SOLANA"
  )
  // A failed re-probe keeps the beat's index, so it never clears a stall.
  Assert.equal(stalledChain(["ETHEREUM"], {}, beat, previous), "ETHEREUM")
})

test("zero growth bails only once the network has started and its deadline passed", () => {
  Assert.equal(oppGrowthBailReason(false, 0, 0, 2_000, 1_000), null)
  Assert.equal(oppGrowthBailReason(true, 0, 3, 500, 1_000), null)
  Assert.equal(oppGrowthBailReason(true, 1, 3, 2_000, 1_000), null)
  Assert.equal(oppGrowthBailReason(true, 0, 3, 2_000, 1_000, true), null)
  Assert.match(oppGrowthBailReason(true, 0, 3, 2_000, 1_000), /zero growth \(total=3\)/)
  Assert.match(oppGrowthBailReason(true, 0, 3, 2_000, null), /zero growth/)
})

test("the network growth deadline waits for every chain's first boundary", () => {
  const start = "2026-10-01T00:00:00.000",
    startMs = Date.parse(`${start}Z`),
    durations = { ETHEREUM: 60, SOLANA: 150 },
    duration = chain => durations[chain],
    states = {
      ETHEREUM: { current_epoch_index: 1, current_epoch_start: start },
      SOLANA: { current_epoch_index: 1, current_epoch_start: start }
    }
  Assert.equal(networkGrowthDeadlineMs(states, Chains, duration, duration), startMs + 150_000)
  Assert.equal(networkGrowthDeadlineMs({ ETHEREUM: states.ETHEREUM }, Chains, duration, duration), null)
  Assert.equal(networkGrowthDeadlineMs(states, [], duration, duration), null)
})
