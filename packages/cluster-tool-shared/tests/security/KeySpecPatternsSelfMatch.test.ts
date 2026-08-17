import Fs from "node:fs"
import Path from "node:path"
import { KeySpecPatterns } from "@wireio/cluster-tool-shared"

/**
 * The scanner must not flag its OWN shipped artifacts.
 *
 * `wire-debugging-server.cjs` inlines this detector (`external: []`) and its
 * sourcemap carries the source verbatim, so a literal scheme token anywhere in
 * the detector — code OR doc comment — makes every CI archive scan warn forever
 * and blocks re-arming the gate as fail-closed.
 */
describe("KeySpecPatterns self-match", () => {
  /** Every `.ts` under a directory, recursively. */
  function sourcesUnder(root: string): string[] {
    return Fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      const full = Path.join(root, entry.name)
      if (entry.isDirectory()) return sourcesUnder(full)
      return entry.isFile() && full.endsWith(".ts") ? [full] : []
    })
  }

  /**
   * EVERY source file of this package — the bundler inlines the whole package
   * and its sourcemap ships each file verbatim, so a hardcoded list would miss
   * a literal introduced in a third file (which is exactly how the sourcemap
   * stayed dirty after the first fix).
   */
  const sourceFiles = sourcesUnder(Path.join(__dirname, "..", "..", "src"))

  /** Every match of every key-spec pattern in `text`. */
  function hits(text: string): string[] {
    return KeySpecPatterns.flatMap(candidate => {
      const global = new RegExp(candidate.pattern.source, "g")
      return [...text.matchAll(global)].map(match => match[0])
    })
  }

  it("still detects a real inline signing key", () => {
    // The un-narrowed detector is the point — a fix that stopped matching real
    // material would be a fail-OPEN regression, far worse than the self-match.
    expect(
      hits(`--signature-provider PUB_K1_x=${["KE", "Y:"].join("")}PVT_K1_secret`)
    ).toHaveLength(1)
  })

  it("does not flag its own redaction marker", () => {
    expect(hits(`${["KE", "Y:"].join("")}<redacted>`)).toHaveLength(0)
  })

  sourceFiles.forEach(file => {
    it(`does not self-match ${Path.basename(file)}`, () => {
      expect(hits(Fs.readFileSync(file, "utf8"))).toEqual([])
    })
  })

  it("does not flag the BUILT bundle or its sourcemap", () => {
    // The artifacts are what actually ship; the source check above cannot see
    // an esbuild transformation (concatenation is constant-folded back to a
    // literal, which is why the detector assembles its token at runtime).
    const bundleDir = Path.join(
      __dirname,
      "..",
      "..",
      "..",
      "debugging-server",
      "dist",
      "bundle"
    )
    if (!Fs.existsSync(bundleDir)) {
      // Not built in this environment — the source assertions above still hold.
      return
    }
    Fs.readdirSync(bundleDir).forEach(entry =>
      expect({
        entry,
        hits: hits(Fs.readFileSync(Path.join(bundleDir, entry), "utf8"))
      }).toEqual({ entry, hits: [] })
    )
  })
})
