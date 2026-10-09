import { importTuiModule, QLExitCode } from "@wireio/ql-tool-cli/cli/index.js"

import { runWql } from "../../common/runWql.js"
import { createTestContext } from "../../common/testContext.js"

describe("wql tui", () => {
  it("loads the TUI module once for concurrent callers", async () => {
    const [first, second] = await Promise.all([importTuiModule(), importTuiModule()])
    expect(first).toBe(second)
    expect(await importTuiModule()).toBe(first)
    expect(typeof first.runTui).toBe("function")
  })

  it("refuses a non-interactive stdout as a usage error", async () => {
    const run = await runWql(["tui", "-u", "http://node.example"], createTestContext().context)
    expect(run.exitCode).toBe(QLExitCode.usage)
    expect(run.stderr[0]).toMatch(/interactive terminal/)
  })
})
