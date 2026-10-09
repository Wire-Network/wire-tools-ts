// Jest stand-in for the ESM-only `yargs` (jest.config.ts maps "yargs" here).
// scripts/esbuild/jestEsmBundleTransformer.cjs replaces this module with a CommonJS
// bundle of the package named in the require below, so tests run the REAL parser.
module.exports = require("yargs")
