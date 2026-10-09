// The packaged app's build-time identity — ONE module read by webpack (the
// dist/app/package.json the AppManifestPlugin writes) and by electron-builder
// (app id, executable, deb package, maintainer). The product name, version,
// description and Electron version come from this package's package.json; the
// runtime constants (bundle file names, environment variables) stay in
// src/main/AppPaths.ts, which the webpack configs load with
// importTypeScriptModule. Changing a value here renames the installed app.
const Path = require("node:path")

/** The package directory (this file lives in etc/app-identity/). */
const PackagePath = Path.resolve(__dirname, "..", "..")

const manifest = require(Path.join(PackagePath, "package.json"))

/** Executable, deb package and dist/app manifest name. */
const ExecutableName = "wire-ql"

module.exports = {
  PackagePath,
  /** Display name (window titles, menus, installers). */
  ProductName: manifest.productName,
  /** App version. */
  Version: manifest.version,
  /** One-line description (deb synopsis, app manifest). */
  Description: manifest.description,
  /** The pinned Electron version (this package's exact devDependency). */
  ElectronVersion: manifest.devDependencies.electron,
  /** Reverse-DNS application id (macOS bundle id, Windows AppUserModelID). */
  AppId: "network.wire.ql",
  ExecutableName,
  /** `name` of the packaged app's own package.json. */
  ManifestName: ExecutableName,
  /** Debian package name. */
  DebPackageName: ExecutableName,
  /** The .desktop entry name (Electron's app_id / WM_CLASS on Linux). */
  DesktopName: `${ExecutableName}.desktop`,
  /** Author / deb maintainer. */
  Author: "Wire Network",
  /** Homepage (required by the deb metadata). */
  Homepage: "https://docs.wire.network"
}
