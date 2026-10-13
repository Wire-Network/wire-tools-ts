import Fs from "node:fs"
import Path from "node:path"

import { OutputWriter } from "@wireio/ql-tool-cli/cli/index.js"

import { captureLogs, type CapturedLogs } from "../../common/logCapture.js"
import { createTemporaryDirectory } from "../../common/temporaryDirectory.js"

describe("OutputWriter", () => {
  let logs: CapturedLogs

  beforeEach(() => {
    logs = captureLogs()
  })

  afterEach(() => logs.restore())

  it("writes rendered text to the stdout channel without a doubled trailing newline", () => {
    OutputWriter.write("a\nb\n")
    expect(logs.stdout()).toEqual(["a\nb"])
  })

  it("writes to a file, creating parent directories", () => {
    const file = Path.join(createTemporaryDirectory("wql-out-"), "nested", "out.csv")
    OutputWriter.write("x,y\n", file)
    expect(Fs.readFileSync(file, "utf8")).toBe("x,y\n")
    expect(logs.stdout()).toEqual([])
  })

  it("writes listing lines one record each (none for an empty list)", () => {
    OutputWriter.writeLines(["one", "two"])
    OutputWriter.writeLines([])
    expect(logs.stdout()).toEqual(["one", "two"])
  })
})
