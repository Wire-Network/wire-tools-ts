/**
 * Jest transformer for THIS package's TypeScript (src + tests): esbuild
 * transpiles each file to CommonJS (jest's runtime) with the automatic JSX
 * runtime and an inline source map. The package is `type: module`, so ts-jest
 * would treat it as ESM; and the workspace CommonJS packages it imports keep
 * their own ts-jest (nodenext) transform — one ts-jest configuration per jest
 * project, because ts-jest shares its config cache between transform entries.
 * Type checking is `tsc -b`'s job (tsconfig.cjs.jest.json), not the transform's.
 * Test files must not rely on jest.mock hoisting (module mocks live in
 * tests/jest.setup.ts).
 */
const Crypto = require("node:crypto")
const Path = require("node:path")
const esbuild = require("esbuild")

const { LoaderByExtension, Target } = require("./loaders.cjs")

module.exports = {
  /**
   * @param {string} sourceText - the TypeScript source.
   * @param {string} sourcePath - its file.
   * @returns {{ code: string }} CommonJS output with an inline source map.
   */
  process(sourceText, sourcePath) {
    const result = esbuild.transformSync(sourceText, {
      loader: LoaderByExtension[Path.extname(sourcePath)],
      format: "cjs",
      platform: "node",
      target: Target,
      jsx: "automatic",
      sourcemap: "inline",
      sourcefile: sourcePath
    })
    return { code: result.code }
  },
  /**
   * @param {string} sourceText - the source.
   * @param {string} sourcePath - its file.
   * @returns {string} cache key (path + text + esbuild version).
   */
  getCacheKey(sourceText, sourcePath) {
    return Crypto.createHash("sha256").update(`${sourcePath}\0${sourceText}\0${esbuild.version}`).digest("hex")
  }
}
