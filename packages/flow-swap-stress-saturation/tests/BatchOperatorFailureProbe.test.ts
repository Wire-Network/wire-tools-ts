import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { findBatchOperatorFailure } from "./real/realBatchOperatorFailures.js"

describe("findBatchOperatorFailure", () => {
  it("returns the first batch operator outbound delivery failure in the phase window", () => {
    // Given: a preserved cluster has batchop JSONL logs with one rejection inside the phase window.
    const clusterPath = Fs.mkdtempSync(
        Path.join(OS.tmpdir(), "batchop-failure-probe-")
      ),
      logsDir = Path.join(clusterPath, "data", "node_batchop_00", "logs")
    Fs.mkdirSync(logsDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(logsDir, "logs_2026-07-06.jsonl"),
      [
        JSON.stringify({
          ts: "2026-07-06T23:59:59.000Z",
          msg: "outpost_opp_job[old]: outbound delivery failed: stale"
        }),
        "{partial-jsonl",
        JSON.stringify({
          ts: "2026-07-07T00:00:02.000Z",
          msg: "outpost_opp_job[23373300651341:CHAIN_KIND_EVM:31337]: outbound delivery failed: execution reverted"
        }),
        JSON.stringify({
          ts: "2026-07-07T00:00:03.000Z",
          msg: "batch_operator: pushed sysio.msgch::deliver ok"
        })
      ].join("\n")
    )

    // When: the probe scans the phase window.
    const failure = findBatchOperatorFailure(
      clusterPath,
      Date.parse("2026-07-07T00:00:00.000Z"),
      Date.parse("2026-07-07T00:00:05.000Z")
    )

    // Then: the concrete rejection message is returned instead of stale or healthy lines.
    expect(failure).toBe(
      "outpost_opp_job[23373300651341:CHAIN_KIND_EVM:31337]: outbound delivery failed: execution reverted"
    )
  })
})
