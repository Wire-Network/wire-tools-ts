import Assert from "node:assert/strict"
import Fs from "node:fs/promises"
import Os from "node:os"
import Path from "node:path"
import { test } from "node:test"

import { probeAggregateLog } from "../flow-heartbeat-monitor.mjs"

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
