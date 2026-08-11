import * as Fs from "node:fs"
import * as Path from "node:path"

const SourceDir = Path.resolve(__dirname, "../src"),
  ForbiddenDependencyPatterns = [
    ["private node_modules", /node_modules/],
    ["runtime createRequire", /\bcreateRequire\b/],
    ["cross-package relative import", /from\s+["']\.\.\/\.\.\//]
  ] as const

/**
 * Telemetry sources live across several `src/` subdirectories, so the scan is
 * recursive. A non-recursive readdir silently matches nothing and passes
 * vacuously.
 */
const MinimumTelemetryFileCount = 10

describe("telemetry dependency hygiene", () => {
  it("rejects private, transitive, and cross-package dependency access", () => {
    // Given
    const telemetryFiles = Fs.readdirSync(SourceDir, {
      recursive: true,
      encoding: "utf-8"
    }).filter(
      entry =>
        entry.endsWith(".ts") && entry.toLowerCase().includes("telemetry")
    )

    // When
    const violations = telemetryFiles.flatMap(entry => {
      const source = Fs.readFileSync(Path.join(SourceDir, entry), "utf-8")
      return ForbiddenDependencyPatterns.filter(([, pattern]) =>
        pattern.test(source)
      ).map(([label]) => `${entry}: ${label}`)
    })

    // Then
    expect(telemetryFiles.length).toBeGreaterThanOrEqual(
      MinimumTelemetryFileCount
    )
    expect(violations).toEqual([])
  })
})
