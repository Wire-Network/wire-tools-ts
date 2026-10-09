import Fs from "node:fs"
import Path from "node:path"

import { filenameCategoryInterpolator } from "@wireio/shared"

const SourcePath = Path.join(__dirname, "..", "..", "src")

/** Every TypeScript source file. */
function sourceFiles(directory: string): string[] {
  return Fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = Path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe("per-file loggers", () => {
  it.each(sourceFiles(SourcePath).map(file => [Path.relative(SourcePath, file), file]))(
    "%s declares its own `const log = getLogger(__filename)` when it logs",
    (_name, file) => {
      const text = Fs.readFileSync(file, "utf8")
      expect(text).not.toMatch(/getLogger\(\s*["'`]/)
      expect(text).not.toMatch(/export\s+const\s+log\b/)
      if (/\bconst log\b/.test(text)) expect(text).toContain("const log = getLogger(__filename)")
    }
  )

  it("finds the logging modules and derives categories from __filename", () => {
    const logging = sourceFiles(SourcePath).filter(file => Fs.readFileSync(file, "utf8").includes("getLogger(__filename)"))
    expect(logging.map(file => Path.relative(SourcePath, file)).sort()).toEqual(
      expect.arrayContaining(["cli/QLCli.ts", "cli/commands/QueryCommand.ts", "tui/services/QueryService.ts", "tui/runTui.tsx"])
    )
    expect(filenameCategoryInterpolator(Path.join(SourcePath, "cli", "commands", "QueryCommand.ts"))).toBe("cli:commands:QueryCommand")
  })
})
