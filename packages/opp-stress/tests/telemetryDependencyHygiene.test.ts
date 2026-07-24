import * as Fs from "node:fs"
import * as Path from "node:path"

const SourceDir = Path.resolve(__dirname, "../src"),
  ForbiddenDependencyPatterns = [
    ["private node_modules", /node_modules/],
    ["runtime createRequire", /\bcreateRequire\b/],
    ["undeclared ts-pattern", /ts-pattern/],
    ["cross-package relative import", /from\s+["']\.\.\/\.\.\//]
  ] as const

describe("telemetry dependency hygiene", () => {
  it("rejects private, transitive, and cross-package dependency access", () => {
    // Given
    const telemetryFiles = Fs.readdirSync(SourceDir).filter(
      filename =>
        filename.endsWith(".ts") && filename.toLowerCase().includes("telemetry")
    )

    // When
    const violations = telemetryFiles.flatMap(filename => {
      const source = Fs.readFileSync(Path.join(SourceDir, filename), "utf-8")
      return ForbiddenDependencyPatterns.filter(([, pattern]) =>
        pattern.test(source)
      ).map(([label]) => `${filename}: ${label}`)
    })

    // Then
    expect(violations).toEqual([])
  })
})
