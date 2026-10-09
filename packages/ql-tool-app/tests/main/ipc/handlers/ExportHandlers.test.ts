import Fs from "node:fs"
import Path from "node:path"

import { createExportHandlers } from "@wireio/ql-tool-app/main/ipc"

import { FakeWebContents } from "../../../__mocks__/electron.js"
import { TempDirectory } from "../../../common/TempDirectory.js"

const sender = new FakeWebContents() as unknown as Electron.WebContents

describe("createExportHandlers", () => {
  it("writes export contents and round-trips a .sql file", async () => {
    const handlers = createExportHandlers(),
      directory = TempDirectory.create(),
      exportFile = Path.join(directory, "nested", "out.csv"),
      queryFile = Path.join(directory, "q.sql")
    await handlers.exportWrite({ filePath: exportFile, contents: "a,b\n1,2\n" }, sender)
    expect(Fs.readFileSync(exportFile, "utf8")).toBe("a,b\n1,2\n")
    await handlers.writeQueryFile({ filePath: queryFile, text: "SELECT 1" }, sender)
    await expect(handlers.readQueryFile({ filePath: queryFile }, sender)).resolves.toBe("SELECT 1")
  })

  it("an unwritable path surfaces an error naming the path", async () => {
    const directory = TempDirectory.create(),
      blocker = Path.join(directory, "file")
    Fs.writeFileSync(blocker, "")
    const target = Path.join(blocker, "out.csv")
    await expect(createExportHandlers().exportWrite({ filePath: target, contents: "x" }, sender)).rejects.toThrow(
      `could not write ${target}`
    )
  })
})
