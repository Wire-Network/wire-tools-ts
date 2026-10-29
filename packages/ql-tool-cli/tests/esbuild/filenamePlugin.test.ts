import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { pathToFileURL } from "node:url"
import Vm from "node:vm"

import * as esbuild from "esbuild"

import { createFilenamePlugin, injectFilename, isWorkspaceModule, RepositoryRoot, wireDependencyFilename } from "../../scripts/esbuild/filenamePlugin.cjs"
import { createTemporaryDirectory } from "../common/temporaryDirectory.js"

/** A fake repository root and the sibling directory beside it that holds a linked package. */
interface FakeRepository {
  /** The fake wire-tools-ts root. */
  root: string
  /** A directory outside `root`, standing in for a linked sibling repo. */
  siblingPath: string
}

/** Writes `text` at `relative` under `root`, creating its directories. */
function writeFile(root: string, relative: string, text: string): void {
  Fs.mkdirSync(Path.dirname(Path.join(root, relative)), { recursive: true })
  Fs.writeFileSync(Path.join(root, relative), text)
}

/** A hybrid `@wireio/*` package at `packagePath`: a named manifest plus a name-less `lib/cjs` type marker. */
function writeWirePackage(packagePath: string, name: string, moduleSource: string): void {
  writeFile(packagePath, "package.json", JSON.stringify({ name }))
  writeFile(packagePath, "lib/cjs/package.json", JSON.stringify({ type: "commonjs" }))
  writeFile(packagePath, "lib/cjs/logged.js", moduleSource)
}

/**
 * A throwaway repository root with two workspace packages and four dependencies: a
 * third-party module, a `@wireio/*` package in node_modules, a `@wireio/*` package
 * that never reads `__filename`, and a `@wireio/*` package in a sibling directory
 * outside the root (as `.pnpmfile.cjs` links them).
 */
function createFakeRepository(): FakeRepository {
  const root = createTemporaryDirectory("wql-filename-"),
    siblingPath = createTemporaryDirectory("wql-filename-sibling-")
  writeFile(root, "packages/alpha/src/one.ts", "export const one: string = __filename\n")
  writeFile(root, "packages/beta/lib/cjs/two.js", "module.exports = { two: __filename }\n")
  writeFile(root, "packages/alpha/node_modules/dep/index.js", "module.exports = { dep: typeof __filename }\n")
  writeWirePackage(Path.join(root, "packages", "alpha", "node_modules", "@wireio", "installed"), "@wireio/installed", "module.exports = { installed: __filename }\n")
  writeWirePackage(Path.join(siblingPath, "packages", "linked"), "@wireio/linked", "module.exports = { linked: __filename }\n")
  writeFile(root, "packages/alpha/node_modules/@wireio/quiet/package.json", JSON.stringify({ name: "@wireio/quiet" }))
  writeFile(root, "packages/alpha/node_modules/@wireio/quiet/index.js", "module.exports = { quiet: 1 }\n")
  writeFile(
    root,
    "packages/alpha/src/entry.ts",
    [
      'import { one } from "./one"',
      'import { two } from "../../beta/lib/cjs/two.js"',
      'import { dep } from "../node_modules/dep/index.js"',
      'import { installed } from "../node_modules/@wireio/installed/lib/cjs/logged.js"',
      `import { linked } from ${JSON.stringify(Path.join(siblingPath, "packages", "linked", "lib", "cjs", "logged.js"))}`,
      'import { quiet } from "../node_modules/@wireio/quiet/index.js"',
      "export const names = { one, two, dep, installed, linked, quiet, entry: __filename }",
      ""
    ].join("\n")
  )
  return { root, siblingPath }
}

describe("filenamePlugin", () => {
  // The async build API keeps an esbuild service child; stop (and await) it so it never outlives the suite.
  afterAll(() => esbuild.stop())

  it("anchors RepositoryRoot at the wire-tools-ts root from scripts/esbuild/", () => {
    expect(Fs.existsSync(Path.join(RepositoryRoot, "packages", "ql-tool-cli", "scripts", "esbuild", "filenamePlugin.cjs"))).toBe(true)
  })

  it("prepends the repo-relative __filename on line 1 (no line shift)", () => {
    expect(injectFilename("export const x = 1\nline2", "packages/a/src/x.ts")).toBe(
      'const __filename = "packages/a/src/x.ts";export const x = 1\nline2'
    )
  })

  it("fails loudly when a module declares its own __filename", () => {
    expect(() => injectFilename("const __filename = 'mine'", "packages/a/src/x.ts")).toThrow(/declares its own __filename/)
  })

  it("selects workspace src/lib modules only (never node_modules or outside the root)", () => {
    expect(isWorkspaceModule(Path.join(RepositoryRoot, "packages", "ql-shared", "lib", "cjs", "index.js"), RepositoryRoot)).toBe(true)
    expect(isWorkspaceModule(Path.join(RepositoryRoot, "packages", "x", "node_modules", "y", "src", "a.js"), RepositoryRoot)).toBe(false)
    expect(isWorkspaceModule(Path.join(RepositoryRoot, "packages", "x", "esbuild", "a.cjs"), RepositoryRoot)).toBe(false)
    expect(isWorkspaceModule("/elsewhere/packages/shared/lib/esm/index.js", RepositoryRoot)).toBe(false)
  })

  it("names a @wireio/* dependency module by package name and package-relative path", () => {
    const { root, siblingPath } = createFakeRepository(),
      cache = new Map()
    expect(wireDependencyFilename(Path.join(root, "packages", "alpha", "node_modules", "@wireio", "installed", "lib", "cjs", "logged.js"), cache)).toBe(
      "@wireio/installed/lib/cjs/logged.js"
    )
    expect(wireDependencyFilename(Path.join(siblingPath, "packages", "linked", "lib", "cjs", "logged.js"), cache)).toBe("@wireio/linked/lib/cjs/logged.js")
  })

  it("names no other dependency module (third-party, or outside any package)", () => {
    const { root } = createFakeRepository(),
      cache = new Map()
    writeFile(root, "packages/alpha/node_modules/dep/package.json", JSON.stringify({ name: "dep" }))
    expect(wireDependencyFilename(Path.join(root, "packages", "alpha", "node_modules", "dep", "index.js"), cache)).toBeNull()
    expect(wireDependencyFilename(Path.join(createTemporaryDirectory("wql-filename-bare-"), "loose.js"), cache)).toBeNull()
  })

  it("gives every bundled module its own path (ESM scope hoisting + CJS wrappers); third-party untouched", async () => {
    const { root } = createFakeRepository(),
      build = (format: esbuild.Format) =>
        esbuild.build({
          entryPoints: [Path.join(root, "packages", "alpha", "src", "entry.ts")],
          bundle: true,
          write: false,
          format,
          platform: "node",
          logLevel: "silent",
          plugins: [createFilenamePlugin({ repositoryRoot: root })]
        }),
      esm = (await build("esm")).outputFiles[0].text,
      cjs = (await build("cjs")).outputFiles[0].text,
      module = { exports: {} as Record<string, Record<string, string>> }
    expect(esm).toMatch(/__filename2/)
    Vm.runInNewContext(cjs, { module, exports: module.exports, require })
    expect(module.exports.names).toEqual({
      one: "packages/alpha/src/one.ts",
      two: "packages/beta/lib/cjs/two.js",
      dep: "undefined",
      installed: "@wireio/installed/lib/cjs/logged.js",
      linked: "@wireio/linked/lib/cjs/logged.js",
      quiet: 1,
      entry: "packages/alpha/src/entry.ts"
    })
    expect(esm).not.toMatch(/"@wireio\/quiet\//)
  })

  it("loads a @wireio/* dependency that reads __filename at module scope inside the ESM bundle", async () => {
    const { root } = createFakeRepository(),
      bundleFile = Path.join(root, "bundle.mjs"),
      result = await esbuild.build({
        entryPoints: [Path.join(root, "packages", "alpha", "src", "entry.ts")],
        bundle: true,
        outfile: bundleFile,
        format: "esm",
        platform: "node",
        logLevel: "silent",
        plugins: [createFilenamePlugin({ repositoryRoot: root })]
      })
    expect(result.errors).toEqual([])
    // A real node process loads the bundle as ESM, as the wql bin does (jest's sandbox cannot import ESM here).
    const printNames = `import { names } from ${JSON.stringify(pathToFileURL(bundleFile).href)}; process.stdout.write(JSON.stringify(names))`,
      names = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", printNames], { encoding: "utf8" }))
    expect(names.installed).toBe("@wireio/installed/lib/cjs/logged.js")
    expect(names.linked).toBe("@wireio/linked/lib/cjs/logged.js")
  })
})
