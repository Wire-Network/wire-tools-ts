/**
 * esbuild plugin: gives every bundled wire-tools-ts workspace module its OWN
 * `__filename` so per-file loggers (`const log = getLogger(__filename)`) keep a
 * real per-module category inside the single ESM bundle (where Node provides no
 * `__filename`).
 *
 * For each resolved file under `<wire-tools-ts>/packages/<pkg>/(src|lib)/` the
 * plugin prepends `const __filename = "<repo-relative path>";` ON THE SAME FIRST
 * LINE (no line shift, so source maps stay exact). esbuild renames the injected
 * const per scope-hoisted ESM module (`__filename2`, …) and keeps it local inside
 * each `__commonJS` wrapper, so every module reads its own value. Files outside
 * the workspace packages (node_modules, sibling repos) are untouched. A module
 * that declares its own `__filename` would collide with the injection — that
 * fails the build loudly instead of being silently shadowed.
 */
const Fs = require("node:fs")
const Path = require("node:path")

const { LoaderByExtension } = require("./loaders.cjs")

/** The wire-tools-ts repository root (this file lives in packages/ql-tool-cli/scripts/esbuild/). */
const RepositoryRoot = Path.resolve(__dirname, "..", "..", "..", "..")

/** Workspace module paths: `packages/<pkg>/(src|lib)/…`. */
const WorkspaceModulePattern = /[\\/]packages[\\/][^\\/]+[\\/](src|lib)[\\/]/

/** A module that declares `__filename` itself. */
const OwnFilenamePattern = /\b(const|let|var)\s+__filename\b/

/**
 * Whether `file` is a wire-tools-ts workspace module the plugin rewrites.
 *
 * @param {string} file - absolute path.
 * @param {string} repositoryRoot - the wire-tools-ts root.
 * @returns {boolean} true for `<root>/packages/<pkg>/(src|lib)/…` outside node_modules.
 */
function isWorkspaceModule(file, repositoryRoot) {
  const relative = Path.relative(repositoryRoot, file)
  return (
    !relative.startsWith("..") &&
    !Path.isAbsolute(relative) &&
    !relative.split(Path.sep).includes("node_modules") &&
    WorkspaceModulePattern.test(`${Path.sep}${relative}`)
  )
}

/**
 * The source text with the injected declaration prepended on line 1.
 *
 * @param {string} source - the module text.
 * @param {string} relativePath - repo-relative path (posix separators).
 * @returns {string} the rewritten text.
 */
function injectFilename(source, relativePath) {
  if (OwnFilenamePattern.test(source)) {
    throw new Error(`filenamePlugin: ${relativePath} declares its own __filename; the injected declaration would collide`)
  }
  return `const __filename = ${JSON.stringify(relativePath)};${source}`
}

/**
 * Create the plugin.
 *
 * @param {{ repositoryRoot?: string }} [options] - root override (tests).
 * @returns {import("esbuild").Plugin} the plugin.
 */
function createFilenamePlugin(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? RepositoryRoot
  return {
    name: "wire-filename",
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx|js|mjs|cjs|jsx)$/ }, async args => {
        if (!isWorkspaceModule(args.path, repositoryRoot)) return undefined
        const source = await Fs.promises.readFile(args.path, "utf8"),
          relativePath = Path.relative(repositoryRoot, args.path).split(Path.sep).join("/")
        return {
          contents: injectFilename(source, relativePath),
          loader: LoaderByExtension[Path.extname(args.path)],
          resolveDir: Path.dirname(args.path)
        }
      })
    }
  }
}

module.exports = { createFilenamePlugin, injectFilename, isWorkspaceModule, RepositoryRoot }
