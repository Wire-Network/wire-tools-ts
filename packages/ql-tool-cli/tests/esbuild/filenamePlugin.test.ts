import Fs from "node:fs"
import Path from "node:path"
import Vm from "node:vm"

import * as esbuild from "esbuild"

import { createFilenamePlugin, injectFilename, isWorkspaceModule, RepositoryRoot } from "../../scripts/esbuild/filenamePlugin.cjs"
import { createTemporaryDirectory } from "../common/temporaryDirectory.js"

/** A throwaway repository root with two workspace packages. */
function createFakeRepository(): string {
  const root = createTemporaryDirectory("wql-filename-"),
    write = (relative: string, text: string) => {
      Fs.mkdirSync(Path.dirname(Path.join(root, relative)), { recursive: true })
      Fs.writeFileSync(Path.join(root, relative), text)
    }
  write("packages/alpha/src/one.ts", "export const one: string = __filename\n")
  write("packages/beta/lib/cjs/two.js", "module.exports = { two: __filename }\n")
  write("packages/alpha/node_modules/dep/index.js", "module.exports = { dep: typeof __filename }\n")
  write(
    "packages/alpha/src/entry.ts",
    'import { one } from "./one"\nimport { two } from "../../beta/lib/cjs/two.js"\nimport { dep } from "../node_modules/dep/index.js"\nexport const names = { one, two, dep, entry: __filename }\n'
  )
  return root
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

  it("gives every bundled module its own path (ESM scope hoisting + CJS wrappers); third-party untouched", async () => {
    const root = createFakeRepository(),
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
      entry: "packages/alpha/src/entry.ts"
    })
  })
})
