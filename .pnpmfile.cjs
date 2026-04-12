// noinspection JSUnresolvedReference

/**
 * pnpm hook to resolve @wireio packages from the local wire-libraries-ts monorepo.
 *
 * Usage:
 *   1. Add packages you want to link to the `localOverrides` map below.
 *   2. Run `pnpm install` — pnpm will use these local paths instead of the registry.
 *   3. Comment out or remove entries to revert to registry versions.
 *
 * Docs: https://pnpm.io/pnpmfile
 */

const Path = require("path")
const Fs = require("node:fs")

// Resolve relative to this file's location
const wireLibPackagesPath = Path.resolve(
  __dirname,
  "..",
  "wire-libraries-ts",
  "packages"
)
const wireOPPPkgPaths = ["typescript", "solidity"].map(target => [
  `@wireio/opp-${target}-models`,
  Path.resolve(__dirname, "..", "wire-opp", target)
])

/**
 * Checks whether a path exists and is a directory, without throwing.
 *
 * @param {string} dirPath
 * @returns {boolean}
 */
function isDirectory(dirPath) {
  try {
    return Fs.lstatSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Map of package names to their local directory in wire-libraries-ts.
 * Uncomment the entries you want to link locally.
 */
const localOverrides = isDirectory(wireLibPackagesPath)
  ? {
      "@wireio/sdk-core": `${wireLibPackagesPath}/sdk-core`,
      "@wireio/shared": `${wireLibPackagesPath}/shared`,
      "@wireio/shared-node": `${wireLibPackagesPath}/shared-node`
    }
  : {}

wireOPPPkgPaths
  .filter(([, path]) => isDirectory(path))
  .forEach(([pkgName, path]) => {
    localOverrides[pkgName] = path
  })

/**
 * `readPackage` hook, which links locally available versions of
 * shared libraries and models.
 *
 * @param pkg
 * @param context
 * @returns {*}
 */
function readPackage(pkg, context) {
  for (const [name, localPath] of Object.entries(localOverrides)) {
    if (pkg.dependencies && pkg.dependencies[name]) {
      pkg.dependencies[name] = `link:${localPath}`
      context.log(`Linked ${name} -> ${localPath}`)
    }
    if (pkg.devDependencies && pkg.devDependencies[name]) {
      pkg.devDependencies[name] = `link:${localPath}`
      context.log(`Linked ${name} -> ${localPath}`)
    }
  }
  return pkg
}

module.exports = {
  hooks: {
    readPackage
  }
}
