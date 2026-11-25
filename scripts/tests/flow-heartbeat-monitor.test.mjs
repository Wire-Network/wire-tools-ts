import Assert from "node:assert/strict"
import Fs from "node:fs/promises"
import Os from "node:os"
import Path from "node:path"
import { test } from "node:test"

import { SlugName } from "@wireio/sdk-core"

import {
  bootstrapBailReason,
  bootstrapDeadlineSeconds,
  chainBacklogReports,
  chainEligibleOperators,
  chainDueAtMs,
  chainEpochDurationSeconds,
  chainGroupOnDuty,
  chainOverdueSeconds,
  chainTraffic,
  ChainTraffic,
  completeTableValues,
  describeBacklogReports,
  describeChainEpochs,
  directionFreezeStreaks,
  firstEpochGrowthDeadlineMs,
  headStallBailReason,
  isHeadFrozen,
  isStallReprobeDue,
  monitoredChains,
  networkGrowthDeadlineMs,
  OppDirections,
  oppGrowthBailReason,
  overdueChains,
  plateauDirection,
  probeAggregateLog,
  resolveChainEpochDurations,
  slugCellCodename,
  stallReprobeDueChains,
  stalledChain,
  undecidedEpochAllowanceSeconds,
  undecidedEpochBailReason,
  undecidedEpochSince
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

/** A zero `time_point`: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"
/** A chain's `due_at` in the fixtures below, and its epoch ms. */
const DueAt = "2026-10-01T00:02:00.000",
  DueAtMs = Date.parse(`${DueAt}Z`)

/** A started chain's epoch row at `index`, due at `dueAt` (zero: idle). */
function epochRow(index, dueAt = NoTraffic, isPaused = false) {
  return { current_epoch_index: index, current_epoch_start: "2026-10-01T00:00:00.000", due_at: dueAt, is_paused: isPaused }
}

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

test("the heartbeat lists every chain's epoch, marks only a boolean pause, and marks idle, waiting and due", () => {
  Assert.equal(describeChainEpochs({ ETHEREUM: epochRow(4, NoTraffic, true), SOLANA: epochRow(2) }, Chains), "ETHEREUM:4pi,SOLANA:2i")
  Assert.equal(describeChainEpochs({ ETHEREUM: { ...epochRow(4), is_paused: 1 } }, ["ETHEREUM"]), "ETHEREUM:4i")
  // A row without a due_at is unknown traffic, never idle.
  Assert.equal(
    describeChainEpochs({ ETHEREUM: { current_epoch_index: 4, is_paused: true }, SOLANA: { current_epoch_index: 2 } }, Chains),
    "ETHEREUM:4p?,SOLANA:2?"
  )
  Assert.equal(
    describeChainEpochs({ ETHEREUM: epochRow(4, DueAt), SOLANA: epochRow(2, DueAt, true) }, Chains, DueAtMs - 1),
    "ETHEREUM:4w,SOLANA:2pw"
  )
  Assert.equal(describeChainEpochs({ ETHEREUM: epochRow(4, DueAt) }, ["ETHEREUM"], DueAtMs), "ETHEREUM:4d")
  // Before its genesis a chain carries no traffic mark.
  Assert.equal(describeChainEpochs({ ETHEREUM: epochRow(0) }, ["ETHEREUM"], DueAtMs), "ETHEREUM:0")
  Assert.equal(describeChainEpochs({}, ["ETHEREUM"]), "ETHEREUM:?")
  Assert.equal(describeChainEpochs({}, []), "?")
})

test("a chain's due_at is its traffic deadline; a zero, absent or unparseable cell is no readable deadline", () => {
  Assert.equal(chainDueAtMs(epochRow(3, DueAt)), DueAtMs)
  Assert.equal(chainDueAtMs(epochRow(3)), null)
  Assert.equal(chainDueAtMs({ due_at: "not a time" }), null)
  Assert.equal(chainDueAtMs(undefined), null)
})

test("a started chain whose due_at is absent or does not parse is unknown, marked ?, never idle", () => {
  const { due_at: _dueAt, ...withoutDueAt } = epochRow(3)
  Assert.equal(chainTraffic(withoutDueAt, DueAtMs), ChainTraffic.unknown)
  Assert.equal(chainTraffic(epochRow(3, "not a time"), DueAtMs), ChainTraffic.unknown)
  Assert.equal(describeChainEpochs({ ETHEREUM: withoutDueAt }, ["ETHEREUM"], DueAtMs), "ETHEREUM:3?")
  Assert.equal(describeChainEpochs({ ETHEREUM: { ...withoutDueAt, is_paused: true } }, ["ETHEREUM"], DueAtMs), "ETHEREUM:3p?")
  // Unknown traffic is never overdue, so no due-chain bail measures it either.
  Assert.equal(chainOverdueSeconds(withoutDueAt, DueAtMs + 600_000), null)
  Assert.deepEqual(overdueChains(["ETHEREUM"], { ETHEREUM: withoutDueAt }, DueAtMs + 600_000, 90), [])
})

test("the heartbeat marks a started chain whose current epoch outpcons has not decided with u", () => {
  const states = { ETHEREUM: epochRow(4), SOLANA: epochRow(2, DueAt) }
  Assert.equal(
    describeChainEpochs(states, Chains, DueAtMs, { ETHEREUM: { epoch_index: 4 }, SOLANA: { epoch_index: 1 } }),
    "ETHEREUM:4i,SOLANA:2du"
  )
  // No outpcons read this beat: nothing is marked undecided.
  Assert.equal(describeChainEpochs(states, Chains, DueAtMs, null), "ETHEREUM:4i,SOLANA:2d")
  // A chain before its genesis carries no mark at all.
  Assert.equal(describeChainEpochs({ ETHEREUM: epochRow(0) }, ["ETHEREUM"], DueAtMs, {}), "ETHEREUM:0")
})

test("a started chain is idle without traffic, waiting before due_at and due from it", () => {
  Assert.equal(chainTraffic(epochRow(3), DueAtMs), ChainTraffic.idle)
  Assert.equal(chainTraffic(epochRow(3, DueAt), DueAtMs - 1), ChainTraffic.waiting)
  Assert.equal(chainTraffic(epochRow(3, DueAt), DueAtMs), ChainTraffic.due)
  // An unknown head never makes a chain due; a chain before its genesis or without a row has none.
  Assert.equal(chainTraffic(epochRow(3, DueAt), null), ChainTraffic.waiting)
  Assert.equal(chainTraffic(epochRow(0), DueAtMs), null)
  Assert.equal(chainTraffic(undefined, DueAtMs), null)
})

test("only a chain with traffic is ever overdue, measured on the depot head", () => {
  Assert.equal(chainOverdueSeconds(epochRow(3, DueAt), DueAtMs + 90_000), 90)
  Assert.equal(chainOverdueSeconds(epochRow(3, DueAt), DueAtMs - 30_000), -30)
  Assert.equal(chainOverdueSeconds(epochRow(3), DueAtMs + 90_000), null)
  Assert.equal(chainOverdueSeconds(epochRow(3, DueAt), null), null)
  Assert.equal(chainOverdueSeconds(epochRow(0, DueAt), DueAtMs), null)
  const states = { ETHEREUM: epochRow(3, DueAt), SOLANA: epochRow(5) }
  Assert.deepEqual(overdueChains(Chains, states, DueAtMs + 90_000, 90), ["ETHEREUM"])
  Assert.deepEqual(overdueChains(Chains, states, DueAtMs + 89_000, 90), [])
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

test("a stall re-probe waits until a due chain is about two of its minimums past due_at", () => {
  // 60 s minimum: 75 s past due plus the 45 s re-probe reaches 120 s.
  Assert.equal(isStallReprobeDue(75, 60), true)
  Assert.equal(isStallReprobeDue(74, 60), false)
  // 150 s minimum: a chain needs 255 s past due.
  Assert.equal(isStallReprobeDue(180, 150), false)
  Assert.equal(isStallReprobeDue(255, 150), true)
  // An idle chain is never re-probed, however long it stays in its epoch.
  Assert.equal(isStallReprobeDue(null, 60), false)
})

test("only due chains at their previous epoch whose grace has run out are re-probed; idle ones never", () => {
  const durations = { ETHEREUM: 60, SOLANA: 150 },
    duration = chain => durations[chain],
    overdue = { ETHEREUM: 90, SOLANA: 90 }
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 4, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, chain => overdue[chain], duration),
    ["ETHEREUM"]
  )
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 5, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, () => 270, duration),
    ["SOLANA"]
  )
  // Idle chains (no overdue time) stay in their epoch without a re-probe.
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 4, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, () => null, duration),
    []
  )
  // A chain this beat could not read is never due.
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: undefined, SOLANA: 2 }, { SOLANA: 3 }, () => 90, duration),
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

test("zero growth bails only once the network has started, its deadline passed and a chain is overdue", () => {
  const overdue = ["ETHEREUM"]
  Assert.equal(oppGrowthBailReason(false, 0, 0, 2_000, 1_000, false, overdue), null)
  Assert.equal(oppGrowthBailReason(true, 0, 3, 500, 1_000, false, overdue), null)
  Assert.equal(oppGrowthBailReason(true, 1, 3, 2_000, 1_000, false, overdue), null)
  Assert.equal(oppGrowthBailReason(true, 0, 3, 2_000, 1_000, true, overdue), null)
  Assert.match(oppGrowthBailReason(true, 0, 3, 2_000, 1_000, false, overdue), /zero growth \(total=3\).*ETHEREUM is due/)
  Assert.match(oppGrowthBailReason(true, 0, 3, 2_000, null, false, overdue), /zero growth/)
  // An idle cluster grows nothing and is healthy.
  Assert.equal(oppGrowthBailReason(true, 0, 3, 2_000, 1_000), null)
  Assert.equal(oppGrowthBailReason(true, 0, 3, 2_000, 1_000, false, []), null)
})

test("the first growth deadline is the genesis epoch start plus the minimum, 0 past it, null before it", () => {
  const start = "2026-10-01T00:00:00.000",
    startMs = Date.parse(`${start}Z`)
  Assert.equal(firstEpochGrowthDeadlineMs({ current_epoch_index: 1, current_epoch_start: start }, 60), startMs + 60_000)
  Assert.equal(firstEpochGrowthDeadlineMs({ current_epoch_index: 2, current_epoch_start: start }, 60), 0)
  Assert.equal(firstEpochGrowthDeadlineMs({ current_epoch_index: 1, current_epoch_start: "invalid" }, 60), 0)
  Assert.equal(firstEpochGrowthDeadlineMs({ current_epoch_index: 0 }, 60), null)
  Assert.equal(firstEpochGrowthDeadlineMs(undefined, 60), null)
})

test("a direction's freeze streak grows only while its chain is due, every direction has a baseline and the total moved", () => {
  const zero = Object.fromEntries(OppDirections.map(direction => [direction.name, 0])),
    counts = { DEPOT_OUTPOST_ETHEREUM: 4, OUTPOST_ETHEREUM_DEPOT: 4, DEPOT_OUTPOST_SOLANA: 2, OUTPOST_SOLANA_DEPOT: 2 },
    moved = { ...counts, DEPOT_OUTPOST_SOLANA: 3, OUTPOST_SOLANA_DEPOT: 3 }
  // Ethereum due and frozen while Solana flows: both Ethereum directions grow their streak.
  const once = directionFreezeStreaks(zero, counts, moved, 2, ["ETHEREUM"])
  Assert.deepEqual(once, { DEPOT_OUTPOST_ETHEREUM: 1, OUTPOST_ETHEREUM_DEPOT: 1, DEPOT_OUTPOST_SOLANA: 0, OUTPOST_SOLANA_DEPOT: 0 })
  Assert.equal(plateauDirection(once), null)
  const twice = directionFreezeStreaks(once, moved, { ...moved, OUTPOST_SOLANA_DEPOT: 4 }, 1, ["ETHEREUM"])
  Assert.equal(plateauDirection(twice), "DEPOT_OUTPOST_ETHEREUM")
  // An idle (or waiting) Ethereum never counts, however long it stands still.
  Assert.deepEqual(directionFreezeStreaks(once, counts, moved, 2, []), zero)
  // No baseline on every direction, or no total growth: nothing counts.
  Assert.deepEqual(directionFreezeStreaks(once, counts, { ...moved, DEPOT_OUTPOST_ETHEREUM: 0 }, 2, ["ETHEREUM"]), zero)
  Assert.deepEqual(directionFreezeStreaks(once, counts, counts, 0, ["ETHEREUM"]), zero)
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
  Assert.equal(networkGrowthDeadlineMs(states, Chains, duration), startMs + 150_000)
  Assert.equal(networkGrowthDeadlineMs({ ETHEREUM: states.ETHEREUM }, Chains, duration), null)
  Assert.equal(networkGrowthDeadlineMs(states, [], duration), null)
})

// ── head advance (wall clock) ──────────────────────────────────────────────

/** The beat interval the head fixtures below run at (s). */
const BeatSeconds = 90

test("the head is frozen only when two read beats show the same block", () => {
  Assert.equal(isHeadFrozen(120, 120), true)
  Assert.equal(isHeadFrozen(120, 300), false)
  Assert.equal(isHeadFrozen(null, 120), false)
  Assert.equal(isHeadFrozen(120, null), false)
})

test("a frozen head with a due chain bails, though the frozen head time hides the stall from the epoch bails", () => {
  // The chain fell due just before the producers stopped: the head time froze with it, so the
  // chain reads due but never overdue by the grace, and the epoch-stall rule never re-probes it.
  const frozenHeadTimeMs = DueAtMs + 1_000,
    states = { ETHEREUM: epochRow(4, DueAt) }
  Assert.equal(chainTraffic(states.ETHEREUM, frozenHeadTimeMs), ChainTraffic.due)
  Assert.deepEqual(overdueChains(["ETHEREUM"], states, frozenHeadTimeMs, BeatSeconds), [])
  Assert.equal(isStallReprobeDue(chainOverdueSeconds(states.ETHEREUM, frozenHeadTimeMs), 60), false)
  Assert.match(headStallBailReason(500, 500, 500, BeatSeconds), /depot head frozen at block 500 for 105s/)
})

test("a frozen head with only idle chains bails too: idle never excuses stopped producers", () => {
  const states = { ETHEREUM: epochRow(4), SOLANA: epochRow(2) }
  Assert.deepEqual(overdueChains(Chains, states, DueAtMs, BeatSeconds), [])
  Assert.match(headStallBailReason(500, 500, 500, BeatSeconds), /the producers stopped/)
  // A failed re-probe keeps the beat's head, so it never clears the bail.
  Assert.match(headStallBailReason(500, 500, null, BeatSeconds), /frozen at block 500/)
})

test("a head that moves again by the re-probe does not bail", () => {
  Assert.equal(headStallBailReason(500, 500, 530, BeatSeconds), null)
})

test("a live head with idle chains never bails", () => {
  const states = { ETHEREUM: epochRow(4), SOLANA: epochRow(2) },
    consensus = { ETHEREUM: { epoch_index: 4 }, SOLANA: { epoch_index: 2 } },
    since = { ETHEREUM: { epochIndex: 4, sinceMs: 0 }, SOLANA: { epochIndex: 2, sinceMs: 0 } },
    duration = () => 60,
    // Hours of idleness on a live head.
    headTimeMs = DueAtMs + 6 * 3_600_000
  Assert.equal(headStallBailReason(500, 700, null, BeatSeconds), null)
  Assert.deepEqual(overdueChains(Chains, states, headTimeMs, BeatSeconds), [])
  Assert.deepEqual(
    stallReprobeDueChains(Chains, { ETHEREUM: 4, SOLANA: 2 }, { ETHEREUM: 4, SOLANA: 2 }, chain => chainOverdueSeconds(states[chain], headTimeMs), duration),
    []
  )
  Assert.equal(undecidedEpochBailReason(Chains, states, consensus, since, headTimeMs, duration), null)
  Assert.equal(oppGrowthBailReason(true, 0, 9, headTimeMs, 0, false, []), null)
})

// ── undecided too long ─────────────────────────────────────────────────────

/** The fixtures' epoch start (`epochRow`'s `current_epoch_start`) in ms. */
const EpochStartMs = Date.parse("2026-10-01T00:00:00.000Z")

test("an epoch may stay undecided 5 minimums, never under the 7-minute single-hop floor", () => {
  Assert.equal(undecidedEpochAllowanceSeconds(150), 750)
  Assert.equal(undecidedEpochAllowanceSeconds(90), 450)
  Assert.equal(undecidedEpochAllowanceSeconds(60), 420)
  Assert.equal(undecidedEpochAllowanceSeconds(30), 420)
  Assert.equal(undecidedEpochAllowanceSeconds(10), 420)
  // Every minimum gets at least the time a live chain needs to decide an epoch: the genesis
  // gate's max(3 x (minimum + 30), 240) s round trip. No dispute timer adds to it.
  ;[10, 30, 45, 50, 60, 90, 110, 111, 150, 360, 3_600].forEach(minimum =>
    Assert.ok(undecidedEpochAllowanceSeconds(minimum) >= Math.max(3 * (minimum + 30), 240), `minimum ${minimum}s`)
  )
})

test("the undecided clock carries over within an epoch, restarts at a seen advance, and skips a downtime", () => {
  const headTimeMs = EpochStartMs + 3_600_000
  // First sight of the chain (late attach, relaunch): no earlier than this beat's head.
  Assert.deepEqual(undecidedEpochSince(undefined, epochRow(4), headTimeMs), { epochIndex: 4, sinceMs: headTimeMs })
  Assert.deepEqual(undecidedEpochSince(undefined, epochRow(4), null), { epochIndex: 4, sinceMs: EpochStartMs })
  // An advance the monitor saw: from the new epoch's start.
  Assert.deepEqual(undecidedEpochSince({ epochIndex: 3, sinceMs: 7 }, epochRow(4), headTimeMs), {
    epochIndex: 4,
    sinceMs: EpochStartMs
  })
  // The same epoch: unchanged.
  const record = { epochIndex: 4, sinceMs: 11 }
  Assert.equal(undecidedEpochSince(record, epochRow(4), headTimeMs), record)
  // No row, or an unreadable start: no record.
  Assert.equal(undecidedEpochSince(record, undefined, headTimeMs), null)
  Assert.equal(undecidedEpochSince(record, { current_epoch_index: 4, current_epoch_start: "x" }, headTimeMs), null)
})

test("a chain whose current epoch, genesis included, stays undecided past its allowance bails", () => {
  const states = { ETHEREUM: epochRow(1), SOLANA: epochRow(2) },
    since = { ETHEREUM: { epochIndex: 1, sinceMs: EpochStartMs }, SOLANA: { epochIndex: 2, sinceMs: EpochStartMs } },
    consensus = { SOLANA: { epoch_index: 2 } },
    duration = () => 60
  Assert.match(
    undecidedEpochBailReason(Chains, states, consensus, since, EpochStartMs + 421_000, duration),
    /ETHEREUM epoch 1 undecided for 421s \(allowance 420s; outpcons last decided none\)/
  )
  Assert.equal(undecidedEpochBailReason(Chains, states, consensus, since, EpochStartMs + 420_000, duration), null)
  // Traffic plays no part: an idle chain and a due one bail alike.
  const busy = { ...states, ETHEREUM: epochRow(1, DueAt) }
  Assert.match(undecidedEpochBailReason(Chains, busy, consensus, since, EpochStartMs + 421_000, duration), /ETHEREUM/)
})

test("a decided, paused or unstarted chain, an unread outpcons or head, or --expect-epoch-freeze never bails", () => {
  const since = { ETHEREUM: { epochIndex: 4, sinceMs: EpochStartMs } },
    late = EpochStartMs + 3_600_000,
    duration = () => 60,
    chains = ["ETHEREUM"]
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4) }, { ETHEREUM: { epoch_index: 4 } }, since, late, duration), null)
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4, NoTraffic, true) }, {}, since, late, duration), null)
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(0) }, {}, since, late, duration), null)
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4) }, null, since, late, duration), null)
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4) }, {}, since, null, duration), null)
  Assert.equal(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4) }, {}, since, late, duration, true), null)
  Assert.match(undecidedEpochBailReason(chains, { ETHEREUM: epochRow(4) }, {}, since, late, duration), /ETHEREUM epoch 4/)
})

// ── backlog reports ─────────────────────────────────────────────────────────

/** A started chain's epoch row with its group on duty, idle unless `dueAt` is given. */
function groupRow(index, group, dueAt = NoTraffic) {
  return { ...epochRow(index, dueAt), current_batch_op_group: 1, batch_op_groups: [["other.a"], group] }
}

/** One `qreports` row: `account`'s backlog report on `chain` in its epoch `epochIndex`. */
function report(chain, account, epochIndex) {
  return { chain_code: SlugName.from(chain), account, epoch_index: epochIndex, pending_count: 1 }
}

/** ACTIVE operators, rendered by name (as clio prints the ABI enum), plus one TERMINATED. */
const Operators = [
  { account: "batchop.a", status: "OPERATOR_STATUS_ACTIVE" },
  { account: "batchop.b", status: 3 },
  { account: "batchop.c", status: "OPERATOR_STATUS_ACTIVE" },
  { account: "batchop.d", status: "OPERATOR_STATUS_TERMINATED" }
]

/** Every operator SERVING both chains, except batchop.c, EVICTED from Ethereum. */
const Memberships = ["batchop.a", "batchop.b", "batchop.c", "batchop.d"].flatMap(account =>
  Chains.map(chain => ({
    account,
    chain_code: chain,
    status: account === "batchop.c" && chain === "ETHEREUM" ? "EVICTED" : "SERVING"
  }))
)

test("a slug_name cell names its chain as the spelling or as the packed value", () => {
  Assert.equal(slugCellCodename("ETHEREUM"), "ETHEREUM")
  Assert.equal(slugCellCodename(SlugName.from("SOLANA")), "SOLANA")
  Assert.equal(slugCellCodename(String(SlugName.from("SOLANA"))), "SOLANA")
  Assert.equal(slugCellCodename(0), null)
  Assert.equal(slugCellCodename(null), null)
})

test("a chain's eligible set is its group on duty, ACTIVE and not EVICTED from the chain", () => {
  const group = ["batchop.a", "batchop.b", "batchop.c", "batchop.d", "batchop.x"]
  // batchop.c is EVICTED from Ethereum, batchop.d TERMINATED, batchop.x neither an operator nor a member.
  Assert.deepEqual(chainEligibleOperators(groupRow(4, group), Operators, Memberships, "ETHEREUM"), ["batchop.a", "batchop.b"])
  Assert.deepEqual(chainEligibleOperators(groupRow(4, group), Operators, Memberships, "SOLANA"), ["batchop.a", "batchop.b", "batchop.c"])
  // An operator that never joined the chain is not eligible on it.
  Assert.deepEqual(
    chainEligibleOperators(groupRow(4, ["batchop.a"]), Operators, Memberships.filter(row => row.chain_code !== "SOLANA"), "SOLANA"),
    []
  )
  // A membership whose chain renders packed counts the same.
  Assert.deepEqual(
    chainEligibleOperators(groupRow(4, ["batchop.a"]), Operators, [{ account: "batchop.a", chain_code: SlugName.from("SOLANA"), status: 0 }], "SOLANA"),
    ["batchop.a"]
  )
})

test("a chain's eligible set is unknown without operators, memberships or a group on duty", () => {
  Assert.equal(chainEligibleOperators(groupRow(4, ["batchop.a"]), null, Memberships, "ETHEREUM"), null)
  Assert.equal(chainEligibleOperators(groupRow(4, ["batchop.a"]), Operators, null, "ETHEREUM"), null)
  Assert.equal(chainEligibleOperators(epochRow(4), Operators, Memberships, "ETHEREUM"), null)
  Assert.equal(chainEligibleOperators(undefined, Operators, Memberships, "ETHEREUM"), null)
})

test("a chain's group on duty is the epoch row's current group, every seat included", () => {
  Assert.deepEqual(chainGroupOnDuty(groupRow(4, ["batchop.a", "batchop.b", "batchop.c"])), ["batchop.a", "batchop.b", "batchop.c"])
  Assert.deepEqual(chainGroupOnDuty(groupRow(4, [])), [])
  // No groups, a current group past them, or no row at all.
  Assert.equal(chainGroupOnDuty(epochRow(4)), null)
  Assert.equal(chainGroupOnDuty({ ...groupRow(4, ["batchop.a"]), current_batch_op_group: 5 }), null)
  Assert.equal(chainGroupOnDuty(undefined), null)
})

test("a chain's reporters are its eligible members' reports in its current epoch, over every seat", () => {
  const state = groupRow(4, ["batchop.a", "batchop.b", "batchop.c"]),
    reports = [
      report("ETHEREUM", "batchop.a", 4),
      report("ETHEREUM", "batchop.b", 3), // an earlier epoch never counts again
      report("ETHEREUM", "batchop.c", 4), // a seat no longer eligible: its report never counts
      report("ETHEREUM", "batchop.x", 4), // outside the group
      report("SOLANA", "batchop.b", 4) // another chain
    ]
  // batchop.c lost its eligibility: it still holds a seat, so the majority stays 2 of 3.
  Assert.deepEqual(chainBacklogReports(reports, state, "ETHEREUM", ["batchop.a", "batchop.b"]), { reporters: 1, seats: 3 })
  Assert.deepEqual(chainBacklogReports([], state, "SOLANA", ["batchop.a"]), { reporters: 0, seats: 3 })
})

test("a chain's reporters are unknown without its eligible set, its seats without a group on duty", () => {
  const reports = [report("ETHEREUM", "batchop.a", 4)]
  Assert.deepEqual(chainBacklogReports(reports, groupRow(4, ["batchop.a", "batchop.b"]), "ETHEREUM", null), {
    reporters: null,
    seats: 2
  })
  Assert.deepEqual(chainBacklogReports(reports, epochRow(4), "ETHEREUM", ["batchop.a"]), { reporters: 1, seats: null })
})

test("the heartbeat lists each chain's reporters over its group's seats", () => {
  const group = ["batchop.a", "batchop.b", "batchop.c"],
    states = { ETHEREUM: groupRow(4, group), SOLANA: groupRow(2, ["batchop.a", "batchop.b"]) },
    reports = [report("ETHEREUM", "batchop.a", 4), report("ETHEREUM", "batchop.b", 4), report("SOLANA", "batchop.a", 1)],
    eligible = { ETHEREUM: ["batchop.a", "batchop.b"], SOLANA: ["batchop.a"] }
  Assert.equal(describeBacklogReports(Chains, states, reports, eligible), "ETHEREUM:2/3,SOLANA:0/2")
  Assert.equal(describeBacklogReports(Chains, states, reports, { ETHEREUM: null }), "ETHEREUM:?/3,SOLANA:?/2")
  Assert.equal(describeBacklogReports(Chains, { ETHEREUM: epochRow(4), SOLANA: states.SOLANA }, reports, eligible), "ETHEREUM:2/?,SOLANA:0/2")
  // Before its genesis advance, or without a row, a chain has no epoch to report in.
  Assert.equal(describeBacklogReports(Chains, { ETHEREUM: epochRow(0) }, reports, eligible), "ETHEREUM:?,SOLANA:?")
  Assert.equal(describeBacklogReports(Chains, states, null, eligible), "?")
  Assert.equal(describeBacklogReports([], states, reports, eligible), "?")
})

// ── complete table reads ────────────────────────────────────────────────────

/** A `clio get table` stdout of `rows` (v6 `{key, value}` rows unless already plain). */
function tableOutput(rows, more = false) {
  return JSON.stringify({ rows, more, next_key: "" })
}

test("a complete read unwraps every row value, the qreports and servchains rows alike", () => {
  const reportRow = report("ETHEREUM", "batchop.a", 4),
    membershipRow = { account: "batchop.a", chain_code: "ETHEREUM", status: "SERVING" }
  Assert.deepEqual(completeTableValues(tableOutput([{ key: "1", value: reportRow }])), [reportRow])
  Assert.deepEqual(completeTableValues(tableOutput([{ key: "2", value: membershipRow }])), [membershipRow])
  // A row that is not a v6 KV row reads as itself.
  Assert.deepEqual(completeTableValues(tableOutput([membershipRow])), [membershipRow])
  Assert.deepEqual(completeTableValues(tableOutput([])), [])
})

test("a truncated, unparseable or failed read is unknown, never a short table", () => {
  const rows = [{ key: "1", value: report("ETHEREUM", "batchop.a", 4) }]
  Assert.equal(completeTableValues(tableOutput(rows, true)), null)
  Assert.equal(completeTableValues("{\"rows\": ["), null)
  Assert.equal(completeTableValues(JSON.stringify({ more: false })), null)
  Assert.equal(completeTableValues(null), null)
})
