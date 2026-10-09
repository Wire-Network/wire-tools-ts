/**
 * esbuild plugin: resolves the listed hybrid (CJS + ESM) packages through their
 * `require` condition for EVERY import kind.
 *
 * Without it the bundle carries two copies of such a package — the `import`
 * build for wql's own ESM sources and the `require` build for the CommonJS
 * workspace packages it bundles (`@wireio/ql-shared` requires `@wireio/shared`).
 * Two copies of `@wireio/shared` mean two `LoggingManager` singletons, so the
 * appender and level wql installs would never see ql-shared's log records.
 */

/** Packages forced onto one (CommonJS) copy. */
const DefaultPackagePattern = /^@wireio\/(shared|sdk-core)(\/.*)?$/

/**
 * Create the plugin.
 *
 * @param {{ packagePattern?: RegExp }} [options] - which specifiers to pin.
 * @returns {import("esbuild").Plugin} the plugin.
 */
function createCommonJsResolvePlugin(options = {}) {
  const packagePattern = options.packagePattern ?? DefaultPackagePattern
  return {
    name: "wire-commonjs-resolve",
    setup(build) {
      build.onResolve({ filter: packagePattern }, args => ({
        path: require.resolve(args.path, { paths: [args.resolveDir] })
      }))
    }
  }
}

module.exports = { createCommonJsResolvePlugin, DefaultPackagePattern }
