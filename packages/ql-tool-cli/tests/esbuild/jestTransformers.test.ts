import Path from "node:path"
import Vm from "node:vm"

import esmBundleTransformer from "../../scripts/esbuild/jestEsmBundleTransformer.cjs"
import typeScriptTransformer from "../../scripts/esbuild/jestTypeScriptTransformer.cjs"
import { LoaderByExtension, Target } from "../../scripts/esbuild/loaders.cjs"

/** The module object of a CommonJS evaluation. */
interface EvaluatedModule {
  exports: Record<string, unknown>
}

describe("jest transformers", () => {
  it("share ONE esbuild target with the bundle (a Node target)", () => {
    expect(Target).toMatch(/^node\d+$/)
  })

  it("transpiles this package's TypeScript/TSX to CommonJS with automatic JSX", () => {
    const { code } = typeScriptTransformer.process("export const n: number = 1\nexport const e = <x />\n", "/tmp/a.tsx"),
      module: EvaluatedModule = { exports: {} }
    expect(code).toContain("react/jsx-runtime")
    Vm.runInNewContext(code, { module, exports: module.exports, require: () => ({ jsx: () => "jsx" }) })
    expect(module.exports.n).toBe(1)
    expect(typeScriptTransformer.getCacheKey("a", "/tmp/a.ts")).not.toBe(typeScriptTransformer.getCacheKey("b", "/tmp/a.ts"))
  })

  it("replaces an ESM-only package stand-in with a CommonJS bundle of the real package", () => {
    const standIn = Path.join(__dirname, "..", "..", "scripts", "esbuild", "yargs.jest.cjs"),
      { code } = esmBundleTransformer.process('module.exports = require("yargs")', standIn)
    expect(code).toContain("__esmBundleImportMetaUrl")
    expect(code).not.toMatch(/import\.meta/)
    expect(() => esmBundleTransformer.process("module.exports = 1", standIn)).toThrow(/expected module.exports/)
  })
})

describe("loaders", () => {
  it("maps every source extension the build helpers load, and nothing else", () => {
    expect(LoaderByExtension).toEqual({ ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" })
    expect(LoaderByExtension[".json" as keyof typeof LoaderByExtension]).toBeUndefined()
    expect(Object.isFrozen(LoaderByExtension)).toBe(true)
  })
})
