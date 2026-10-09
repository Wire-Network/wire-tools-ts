import Fs from "node:fs"
import Path from "node:path"

import { filenameCategoryInterpolator } from "@wireio/shared"

const SourcePath = Path.join(__dirname, "..", "..", "src"),
  /** A module that imports getLogger (comments mentioning it do not count). */
  ImportsGetLogger = /import\s*\{[^}]*\bgetLogger\b[^}]*\}\s*from/

/** Every TypeScript source file of the app. */
function sourceFiles(directory: string): string[] {
  return Fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = Path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe("per-file loggers", () => {
  const files = sourceFiles(SourcePath),
    loggingFiles = files.filter(file => ImportsGetLogger.test(Fs.readFileSync(file, "utf8")))

  it("finds the logging modules of every process", () => {
    expect(loggingFiles.map(file => Path.relative(SourcePath, file)).sort()).toEqual(
      expect.arrayContaining([
        "main/AppLifecycle.ts",
        "preload/preload.ts",
        "query-host/QueryHost.ts",
        "renderer/query/QueryPortClient.ts"
      ])
    )
  })

  it.each(files.map(file => [Path.relative(SourcePath, file), file]))(
    "%s declares its own `const log = getLogger(__filename)` when it logs",
    (_name, file) => {
      const text = Fs.readFileSync(file, "utf8")
      expect(text).not.toMatch(/getLogger\(\s*["'`]/)
      expect(text).not.toMatch(/export\s+const\s+log\b/)
      expect(text).not.toMatch(/\bconsole\./)
      if (ImportsGetLogger.test(text)) expect(text).toContain("const log = getLogger(__filename)")
    }
  )

  it("derives each process's category from __filename (webpack injects the same relative path)", () => {
    expect(filenameCategoryInterpolator(Path.join(SourcePath, "main", "AppLifecycle.ts"))).toBe("main:AppLifecycle")
    expect(filenameCategoryInterpolator(Path.join(SourcePath, "renderer", "App.tsx"))).toBe("renderer:App")
  })
})
