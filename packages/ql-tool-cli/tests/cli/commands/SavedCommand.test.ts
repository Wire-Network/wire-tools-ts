import { QLExitCode, SavedCommand } from "@wireio/ql-tool-cli/cli/index.js"

import { runWql } from "../../common/runWql.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { createTestContext } from "../../common/testContext.js"

describe("wql saved", () => {

  const engine = useStubEngine()

  it("saves (argument or stdin), lists, runs and removes", async () => {
    const { context } = createTestContext()
    expect((await runWql(["saved", "save", "first", "SELECT *\nFROM sample.positions"], context)).stdout).toEqual(["saved first"])
    expect((await runWql(["saved", "list"], context)).stdout).toEqual(["first\tSELECT * FROM sample.positions"])
    const run = await runWql(["saved", "run", "first", "-u", engine().endpoint, "-f", "jsonl"], context)
    expect(run.exitCode).toBe(QLExitCode.success)
    expect(run.stdout.join("\n")).toContain('"name":"alice"')
    expect(engine().requests.at(-1).params.query).toBe("SELECT *\nFROM sample.positions")
    await runWql(["saved", "remove", "first"], context)
    expect(context.savedQueryStore.list()).toEqual([])
    const piped = createTestContext({ stdinText: "SELECT 9" }).context
    await runWql(["saved", "save", "piped"], piped)
    expect(piped.savedQueryStore.getByName("piped").query).toBe("SELECT 9")
  })

  it("fails to run or remove an unknown saved query", async () => {
    const { context } = createTestContext()
    expect((await runWql(["saved", "run", "nope", "-u", engine().endpoint], context)).exitCode).toBe(QLExitCode.failure)
    expect((await runWql(["saved", "remove", "nope"], context)).exitCode).toBe(QLExitCode.failure)
  })

  it("formats a listing line on one line", () => {
    expect(SavedCommand.savedLine({ id: "i", name: "n", query: "a\n  b", createdAt: "", updatedAt: "" })).toBe("n\ta b")
  })
})

describe("SavedCommand messages", () => {
  it("confirms a save and a removal by name", () => {
    expect(SavedCommand.savedText("daily")).toBe("saved daily")
    expect(SavedCommand.removedText("daily")).toBe("removed daily")
  })
})
