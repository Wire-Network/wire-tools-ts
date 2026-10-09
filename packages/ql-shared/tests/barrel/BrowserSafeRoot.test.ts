import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { build, stop, type BuildFailure, type Plugin } from "esbuild"

const PackagePath = Path.join(__dirname, "..", ".."),
  RootEntry = Path.join(PackagePath, "src", "index.ts"),
  // Workspace siblings resolve to their sources so the check sees the current tree.
  alias = { "@wireio/cluster-tool-shared": Path.join(PackagePath, "..", "cluster-tool-shared", "src", "index.ts") }

/**
 * `@wireio/sdk-core`'s BLS module imports Node `crypto` only as a guarded
 * fallback (it uses `globalThis.crypto` when present); its browser consumers
 * declare `resolve.fallback: { crypto: false }` (wire-libraries-ts
 * wallet-browser-ext precedent). Mirror exactly that one fallback — `crypto`
 * imported from sdk-core — so every OTHER Node builtin, and `crypto` from any
 * other module, still fails the check.
 */
const SdkCoreCryptoFallback: Plugin = {
  name: "sdk-core-crypto-fallback",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^crypto$/ }, args =>
      /[\\/]sdk-core[\\/]/.test(args.importer) ? { path: args.path, namespace: "sdk-core-crypto-fallback" } : undefined
    )
    pluginBuild.onLoad({ filter: /.*/, namespace: "sdk-core-crypto-fallback" }, () => ({ contents: "module.exports = {}", loader: "js" }))
  }
}

/** Bundle an entry for the browser; resolves to the build errors (empty on success). */
async function browserBundleErrors(entry: string): Promise<string[]> {
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent", alias, plugins: [SdkCoreCryptoFallback] })
    return []
  } catch (error) {
    return (error as BuildFailure).errors.map(message => message.text)
  }
}

describe("browser-safe root barrel", () => {
  // The async build API keeps an esbuild service child; stop (and await) it so it never outlives the suite.
  afterAll(() => stop())

  it("bundles @wireio/ql-shared for platform:browser without any Node builtin", async () => {
    expect(await browserBundleErrors(RootEntry)).toEqual([])
  }, 60_000)

  it.each(["node:fs", "crypto"])("fails when a root-reachable module imports %s", async builtin => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "ql-browser-safe-")),
      entry = Path.join(directory, "entry.ts")
    Fs.writeFileSync(entry, `export * from ${JSON.stringify(RootEntry)}\nimport ${JSON.stringify(builtin)}\n`)
    try {
      expect((await browserBundleErrors(entry)).join("\n")).toContain(builtin)
    } finally {
      Fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
