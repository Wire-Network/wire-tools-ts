/**
 * The ONE esbuild loader table, target and `define` table of this package's build
 * helpers (the bundle config, its filename plugin and both jest transformers).
 */
const Path = require("node:path")

const { version: PackageVersion } = require(Path.join(__dirname, "..", "..", "package.json"))

/** esbuild `target` of every build of this package (the bundle and both jest transformers): the Node runtime the package requires. */
const Target = "node24"

/** Loader per source extension. */
const LoaderByExtension = Object.freeze({ ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" })

/**
 * Compile-time constants replaced in this package's sources, by the bundle AND by
 * the jest transformer: `WQL_PACKAGE_VERSION` is the package's own version, so
 * `wql --version` answers it wherever the bundle is installed (yargs' own lookup
 * reads the `package.json` above the CURRENT DIRECTORY, not above the bundle).
 */
const Define = Object.freeze({ WQL_PACKAGE_VERSION: JSON.stringify(PackageVersion) })

module.exports = { Define, LoaderByExtension, PackageVersion, Target }
