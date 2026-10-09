import Fs from "node:fs"
import Path from "node:path"

import { identity } from "lodash"

import { ExportService } from "@wireio/ql-tool-app/main/services"

import { TempDirectory } from "../../common/TempDirectory.js"

describe("ExportService", () => {
  it("writes contents, creating the directory", async () => {
    const file = Path.join(TempDirectory.create(), "a", "b", "out.json")
    await ExportService.write({ filePath: file, contents: "[]" })
    expect(Fs.readFileSync(file, ExportService.Encoding)).toBe("[]")
  })

  it("reading a missing file names the path and keeps the cause", async () => {
    const file = Path.join(TempDirectory.create(), "missing.sql")
    const error: Error = await ExportService.readQueryFile({ filePath: file }).then(
      () => null,
      identity<Error>
    )
    expect(error.message).toContain(`could not read ${file}`)
    expect(String((error.cause as Error).message)).toContain("ENOENT")
  })
})
