/**
 * Jest transformer for an ESM-only package (yargs ≥ 18, whose platform shim uses
 * `import.meta`): the transformed file is a `<name>.jest.cjs` stand-in whose only
 * statement is `module.exports = require("<package>")`. The transformer resolves
 * that package from the stand-in's directory and returns an esbuild CommonJS
 * bundle of its whole dependency graph, with `import.meta.url` replaced by the
 * entry's file URL. Jest's runtime is CommonJS, so without this the real package
 * cannot load under test; with it, tests exercise the real parser, not a mock.
 */
const Crypto = require("node:crypto")
const Fs = require("node:fs")
const Path = require("node:path")
const esbuild = require("esbuild")

const { Target } = require("./loaders.cjs")

/** Identifier substituted for `import.meta.url`. */
const ImportMetaUrlIdentifier = "__esmBundleImportMetaUrl"
/** The package a stand-in names. */
const RequiredPackagePattern = /require\("([^"]+)"\)/

/**
 * The ESM entry a stand-in names.
 *
 * @param {string} sourceText - the stand-in text.
 * @param {string} sourcePath - the stand-in path.
 * @returns {string} the resolved entry file.
 */
function entryOf(sourceText, sourcePath) {
  const found = RequiredPackagePattern.exec(sourceText)
  if (found == null) throw new Error(`${sourcePath}: expected module.exports = require("<package>")`)
  return require.resolve(found[1], { paths: [Path.dirname(sourcePath)] })
}

module.exports = {
  /**
   * @param {string} sourceText - the stand-in text.
   * @param {string} sourcePath - the stand-in file.
   * @returns {{ code: string }} the CommonJS bundle of the named package.
   */
  process(sourceText, sourcePath) {
    const entry = entryOf(sourceText, sourcePath),
      result = esbuild.buildSync({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        target: Target,
        write: false,
        logLevel: "silent",
        define: { "import.meta.url": ImportMetaUrlIdentifier },
        banner: {
          js: `const ${ImportMetaUrlIdentifier} = ${JSON.stringify(require("node:url").pathToFileURL(entry).href)};`
        }
      })
    return { code: result.outputFiles[0].text }
  },
  /**
   * @param {string} sourceText - the stand-in text.
   * @param {string} sourcePath - the stand-in file.
   * @returns {string} cache key (entry path + entry text + esbuild version).
   */
  getCacheKey(sourceText, sourcePath) {
    const entry = entryOf(sourceText, sourcePath)
    return Crypto.createHash("sha256")
      .update(`${entry}\0${Fs.readFileSync(entry, "utf8")}\0${esbuild.version}`)
      .digest("hex")
  }
}
