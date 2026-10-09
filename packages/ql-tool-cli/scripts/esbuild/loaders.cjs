/**
 * The ONE esbuild loader table and target of this package's build helpers (the
 * bundle config, its filename plugin and both jest transformers).
 */

/** esbuild `target` of every build of this package (the bundle and both jest transformers): the Node runtime the package requires. */
const Target = "node24"

/** Loader per source extension. */
const LoaderByExtension = Object.freeze({ ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" })

module.exports = { LoaderByExtension, Target }
