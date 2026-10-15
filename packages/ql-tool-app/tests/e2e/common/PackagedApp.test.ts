import Path from "node:path"

import type { Configuration } from "electron-builder"

import { QLPlatform } from "@wireio/ql-shared/node"

import { E2EPaths } from "./E2EPaths.js"
import { PackagedApp } from "./PackagedApp.js"

/** The package.json members the hint test reads. */
interface PackageManifest {
  name: string
  scripts: Record<string, string>
}

/** The package root the tests resolve against. */
const { PackagePath } = E2EPaths
/** The package's real builder configuration. */
const RealConfig = require(Path.join(PackagePath, PackagedApp.ConfigFile)) as Configuration
/** The real output directory. */
const Output = Path.join(PackagePath, "dist", "package")

describe("PackagedApp.resolve", () => {
  it.each([
    [QLPlatform.linux, [], Path.join(Output, "linux-unpacked", "wire-ql"), PackagedApp.BuildHint],
    [QLPlatform.win32, [], Path.join(Output, "win-unpacked", "wire-ql.exe"), PackagedApp.BuildHint],
    [QLPlatform.darwin, ["mac"], Path.join(Output, "mac", "wire-ql.app", "Contents", "MacOS", "wire-ql"), PackagedApp.BuildHint],
    [
      QLPlatform.darwin,
      ["linux-unpacked", "mac-arm64"],
      Path.join(Output, "mac-arm64", "wire-ql.app", "Contents", "MacOS", "wire-ql"),
      PackagedApp.BuildHint
    ],
    [QLPlatform.darwin, [], Path.join(Output, "mac", "wire-ql.app", "Contents", "MacOS", "wire-ql"), PackagedApp.BuildHint]
  ])("the real config on %s (output entries %j) → %s", (platform, entries, executablePath, buildHint) => {
    expect(PackagedApp.resolve(platform, RealConfig, PackagePath, entries)).toEqual({ executablePath, buildHint })
  })

  it("follows electron-builder's precedence: platform executableName, top-level, then the product name", () => {
    const base: Configuration = { productName: "My App", directories: { output: "out" } },
      root = Path.join(Path.sep, "pkg")
    expect(PackagedApp.resolve(QLPlatform.linux, base, root, []).executablePath).toBe(Path.join(root, "out", "linux-unpacked", "my app"))
    expect(PackagedApp.resolve(QLPlatform.win32, base, root, []).executablePath).toBe(Path.join(root, "out", "win-unpacked", "My App.exe"))
    expect(PackagedApp.resolve(QLPlatform.darwin, base, root, []).executablePath).toBe(
      Path.join(root, "out", "mac", "My App.app", "Contents", "MacOS", "My App")
    )
    const named: Configuration = { ...base, executableName: "top", linux: { executableName: "lin" }, win: { executableName: "w:in" } }
    expect(PackagedApp.resolve(QLPlatform.linux, named, root, []).executablePath).toBe(Path.join(root, "out", "linux-unpacked", "lin"))
    expect(PackagedApp.resolve(QLPlatform.win32, named, root, []).executablePath).toBe(Path.join(root, "out", "win-unpacked", "win.exe"))
    expect(PackagedApp.resolve(QLPlatform.darwin, named, root, []).executablePath).toBe(
      Path.join(root, "out", "mac", "top.app", "Contents", "MacOS", "top")
    )
    expect(PackagedApp.resolve(QLPlatform.linux, { productName: "x" }, root, []).executablePath).toBe(
      Path.join(root, PackagedApp.DefaultOutputDirectory, "linux-unpacked", "x")
    )
  })

  it("rejects a platform electron-builder does not package", () => {
    expect(() => PackagedApp.resolve("aix", RealConfig, PackagePath, [])).toThrow(/no packaged app layout for platform aix/)
  })

  it("the build hint is the package's package:dir script (no `--` passthrough: pnpm would forward it to electron-builder)", () => {
    const manifest = require(Path.join(PackagePath, "package.json")) as PackageManifest
    expect(PackagedApp.BuildHint).toBe(`pnpm --filter ${manifest.name} run package:dir`)
    expect(manifest.scripts["package:dir"]).toMatch(/electron-builder --config \S+ --dir$/)
    expect(PackagedApp.BuildHint).not.toContain(" -- ")
  })

  it("resolveForHost reads the real config for this host", () => {
    expect(PackagedApp.resolveForHost(PackagePath).executablePath.startsWith(Output)).toBe(true)
  })
})
