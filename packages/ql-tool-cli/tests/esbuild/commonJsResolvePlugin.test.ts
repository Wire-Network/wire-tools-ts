import Path from "node:path"

import type { OnResolveArgs, OnResolveResult, PluginBuild } from "esbuild"

import { createCommonJsResolvePlugin, DefaultPackagePattern } from "../../scripts/esbuild/commonJsResolvePlugin.cjs"

/** The onResolve callback the plugin registers. */
type ResolveCallback = (args: OnResolveArgs) => OnResolveResult

/** What the plugin registered. */
interface CapturedResolve {
  filter: RegExp
  resolve: ResolveCallback
}

/** onResolve options as the plugin passes them. */
interface ResolveOptions {
  filter: RegExp
}

describe("commonJsResolvePlugin", () => {
  /** Run the plugin's setup and capture its callback + filter. */
  function setup(): CapturedResolve {
    let captured: CapturedResolve = null
    createCommonJsResolvePlugin().setup({
      onResolve: (options: ResolveOptions, callback: ResolveCallback) => {
        captured = { filter: options.filter, resolve: callback }
      }
    } as unknown as PluginBuild)
    return captured
  }

  it("resolves @wireio/shared (and its /node subpath) to the CommonJS build for an ESM import", () => {
    const { resolve } = setup(),
      resolveDir = Path.join(__dirname, "..", "..", "src"),
      root = resolve({ path: "@wireio/shared", resolveDir } as OnResolveArgs),
      node = resolve({ path: "@wireio/shared/node", resolveDir } as OnResolveArgs)
    expect(root.path).toMatch(/[\\/]lib[\\/]cjs[\\/]index\.js$/)
    expect(node.path).toMatch(/[\\/]lib[\\/]cjs[\\/]node[\\/]index\.js$/)
  })

  it("pins only the listed packages", () => {
    expect(DefaultPackagePattern.test("@wireio/sdk-core")).toBe(true)
    expect(DefaultPackagePattern.test("@wireio/ql-shared")).toBe(false)
    expect(DefaultPackagePattern.test("lodash")).toBe(false)
    expect(setup().filter).toBe(DefaultPackagePattern)
  })
})
