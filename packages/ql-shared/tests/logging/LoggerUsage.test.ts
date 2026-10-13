import Fs from "node:fs"
import Path from "node:path"

import { filenameCategoryInterpolator } from "@wireio/shared"

const SourcePath = Path.join(__dirname, "..", "..", "src"),
  GeneratedPath = Path.join(SourcePath, "grammar", "generated")

/** Every hand-written TypeScript source file. */
function sourceFiles(directory: string): string[] {
  return Fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = Path.join(directory, entry.name)
    return entry.isDirectory()
      ? full === GeneratedPath
        ? []
        : sourceFiles(full)
      : entry.name.endsWith(".ts")
        ? [full]
        : []
  })
}

describe("per-file loggers", () => {
  const loggingFiles = sourceFiles(SourcePath).filter(file => Fs.readFileSync(file, "utf8").includes("getLogger("))

  it("finds the logging modules", () => {
    expect(loggingFiles.map(file => Path.relative(SourcePath, file)).sort()).toEqual(
      expect.arrayContaining(["client/QueryEngineClient.ts", "catalog/SchemaCatalog.ts", "node/QueryHistoryStore.ts"])
    )
  })

  it.each(sourceFiles(SourcePath).map(file => [Path.relative(SourcePath, file), file]))(
    "%s declares its own `const log = getLogger(__filename)` when it logs",
    (_name, file) => {
      const text = Fs.readFileSync(file, "utf8")
      expect(text).not.toMatch(/getLogger\(\s*["'`]/)
      expect(text).not.toMatch(/export\s+const\s+log\b/)
      if (text.includes("getLogger(")) expect(text).toContain("const log = getLogger(__filename)")
    }
  )

  it("derives the module category from __filename under jest", () => {
    expect(filenameCategoryInterpolator(Path.join(SourcePath, "client", "QueryEngineClient.ts"))).toBe("client:QueryEngineClient")
  })
})
