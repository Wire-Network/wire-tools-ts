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
 * each `__commonJS` wrapper, so every module reads its own value.
 *
 * A bundled `@wireio/*` DEPENDENCY module (from node_modules, or a sibling repo
 * linked by `.pnpmfile.cjs`) that reads `__filename` gets the same injection,
 * named `<package name>/<path within the package>`: in the ESM bundle an
 * unrewritten top-level `getLogger(__filename)` throws a ReferenceError the moment
 * the module loads. Every other dependency module is untouched. A module that
 * declares its own `__filename` would collide with the injection — that fails the
 * build loudly instead of being silently shadowed.
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

/** A module that reads `__filename`. */
const FilenameReferencePattern = /\b__filename\b/

/** The npm scope whose bundled dependency modules also get their own `__filename`. */
const WireScopePrefix = "@wireio/"

/** A package manifest's file name. */
const PackageManifestName = "package.json"

/**
 * A relative path with posix separators (the form every injected `__filename` carries).
 *
 * @param {string} path - a relative path.
 * @returns {string} the path joined with `/`.
 */
function toPosixPath(path) {
  return path.split(Path.sep).join("/")
}

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
 * The nearest package enclosing `file` whose manifest has a `name` (the
 * name-less `lib/cjs/package.json` type markers of hybrid packages are skipped).
 *
 * @param {string} file - absolute path.
 * @param {Map<string, { name: string, root: string } | null>} cache - per-build lookups, keyed by directory.
 * @returns {{ name: string, root: string } | null} the package name and root directory, or null when none encloses it.
 */
function findPackage(file, cache) {
  const visit = directory => {
    if (cache.has(directory)) return cache.get(directory)
    const manifestFile = Path.join(directory, PackageManifestName),
      name = Fs.existsSync(manifestFile) ? JSON.parse(Fs.readFileSync(manifestFile, "utf8")).name : undefined,
      parent = Path.dirname(directory),
      found = name ? { name, root: directory } : parent === directory ? null : visit(parent)
    cache.set(directory, found)
    return found
  }
  return visit(Path.dirname(file))
}

/**
 * The injected `__filename` of a `@wireio/*` dependency module.
 *
 * @param {string} file - absolute path of a module outside the workspace packages.
 * @param {Map<string, { name: string, root: string } | null>} cache - per-build package lookups.
 * @returns {string | null} `<package name>/<path within the package>`, or null for any other package.
 */
function wireDependencyFilename(file, cache) {
  const found = findPackage(file, cache)
  return found && found.name.startsWith(WireScopePrefix)
    ? `${found.name}/${toPosixPath(Path.relative(found.root, file))}`
    : null
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
  const repositoryRoot = options.repositoryRoot ?? RepositoryRoot,
    packageCache = new Map(),
    rewrite = (file, source, filename) => ({
      contents: injectFilename(source, filename),
      loader: LoaderByExtension[Path.extname(file)],
      resolveDir: Path.dirname(file)
    })
  return {
    name: "wire-filename",
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx|js|mjs|cjs|jsx)$/ }, async args => {
        if (isWorkspaceModule(args.path, repositoryRoot)) {
          return rewrite(args.path, await Fs.promises.readFile(args.path, "utf8"), toPosixPath(Path.relative(repositoryRoot, args.path)))
        }
        const filename = wireDependencyFilename(args.path, packageCache)
        if (filename == null) return undefined
        const source = await Fs.promises.readFile(args.path, "utf8")
        return FilenameReferencePattern.test(source) ? rewrite(args.path, source, filename) : undefined
      })
    }
  }
}

module.exports = { createFilenamePlugin, injectFilename, isWorkspaceModule, RepositoryRoot, wireDependencyFilename }
