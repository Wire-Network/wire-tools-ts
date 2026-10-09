// electron-builder packaging of the webpack output (dist/app/): Linux AppImage +
// deb, macOS dmg (unsigned), Windows nsis. `directories.app` points at the
// bundle directory, whose own package.json (written by the main webpack config)
// declares no dependencies — everything is bundled, so no node_modules are
// collected. Every identity value comes from etc/app-identity/app-identity.cjs
// (shared with webpack). This file lives in etc/electron-builder/; every path
// below is absolute (from the package directory), so the build does not depend
// on the working directory.
const Path = require("node:path")

const Identity = require(Path.join(__dirname, "..", "app-identity", "app-identity.cjs"))

/** The brand icon every platform's icon set is derived from. */
const IconFile = Path.join(Identity.PackagePath, "resources", "assets", "brand", "icon-1024.png")

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: Identity.AppId,
  productName: Identity.ProductName,
  executableName: Identity.ExecutableName,
  electronVersion: Identity.ElectronVersion,
  // Everything is bundled: resolving to false tells electron-builder the app's
  // node_modules are handled externally — nothing is installed, rebuilt or
  // collected (it would otherwise fall back to the project/workspace
  // node_modules).
  beforeBuild: async () => false,
  // No auto-update / publish provider (no app-update.yml).
  publish: null,
  directories: {
    app: Path.join(Identity.PackagePath, "dist", "app"),
    output: Path.join(Identity.PackagePath, "dist", "package")
  },
  files: ["**/*", "!**/*.map", "!**/*.LICENSE.txt"],
  icon: IconFile,
  linux: {
    target: ["AppImage", "deb"],
    category: "Development",
    icon: IconFile,
    maintainer: Identity.Author,
    syncDesktopName: true,
    synopsis: Identity.Description
  },
  deb: { packageName: Identity.DebPackageName },
  mac: {
    target: ["dmg"],
    category: "public.app-category.developer-tools",
    // Unsigned (signing/notarization is a follow-up): no identity lookup.
    identity: null
  },
  win: { target: ["nsis"] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
}
