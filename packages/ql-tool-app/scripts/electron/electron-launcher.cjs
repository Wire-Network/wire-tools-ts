/**
 * Launches the unpackaged app with the Electron binary from node_modules — ONE
 * module shared by the `start` script, the webpack dev server (`dev`) and the
 * Playwright e2e harness, so every launch decides the Chromium OS sandbox the
 * same way.
 *
 * Chromium's OS-level process sandbox on Linux needs either unprivileged user
 * namespaces or a root-owned setuid `chrome-sandbox` helper. Ubuntu 24.04
 * restricts user namespaces through AppArmor, and a package-manager install
 * never makes `node_modules/electron/dist/chrome-sandbox` setuid root, so
 * Electron aborts at startup ("The SUID sandbox helper binary was found, but is
 * not configured correctly"). On such a host the launch adds `--no-sandbox`.
 * That switch drops only the OS process sandbox of the launched process tree;
 * the app's webPreferences (context isolation, no Node integration, `sandbox`
 * default) and its Content-Security-Policy are unchanged. Hosts that can run
 * the sandbox get no switch.
 */
const Fs = require("node:fs")
const Path = require("node:path")
const { spawn } = require("node:child_process")

/** Kernel switch restricting unprivileged user namespaces. */
const UserNamespaceRestrictionFile = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
/** The value of {@link UserNamespaceRestrictionFile} meaning "restricted". */
const UserNamespacesRestricted = "1"
/** Chromium switch disabling the OS process sandbox. */
const NoSandboxSwitch = "--no-sandbox"
/** The setuid sandbox helper next to the Electron executable. */
const SandboxHelperFilename = "chrome-sandbox"
/** setuid mode bit. */
const SetUidBit = 0o4000
/** uid of root. */
const RootUid = 0
/** The only platform with a setuid / user-namespace sandbox. */
const LinuxPlatform = "linux"

/**
 * Whether the `chrome-sandbox` helper next to the Electron executable is setuid root.
 *
 * @param {string} electronBinary the Electron executable
 * @return {boolean} whether the setuid helper is usable
 */
function hasSetUidHelper(electronBinary) {
  const helper = Path.join(Path.dirname(electronBinary), SandboxHelperFilename)
  if (!Fs.existsSync(helper)) return false
  const stat = Fs.statSync(helper)
  return stat.uid === RootUid && (stat.mode & SetUidBit) !== 0
}

/**
 * Whether unprivileged user namespaces are available.
 *
 * @return {boolean} false when AppArmor restricts them
 */
function hasUserNamespaces() {
  return (
    !Fs.existsSync(UserNamespaceRestrictionFile) ||
    Fs.readFileSync(UserNamespaceRestrictionFile, "utf8").trim() !== UserNamespacesRestricted
  )
}

/**
 * Extra Electron switches this host needs.
 *
 * @param {string} electronBinary the Electron executable
 * @return {string[]} `[]`, or `["--no-sandbox"]` when no OS sandbox is available
 */
function sandboxSwitches(electronBinary) {
  return process.platform !== LinuxPlatform || hasUserNamespaces() || hasSetUidHelper(electronBinary)
    ? []
    : [NoSandboxSwitch]
}

/**
 * The Electron executable installed in node_modules.
 *
 * @return {string} its absolute path
 */
function electronBinary() {
  return require("electron")
}

/**
 * Spawn Electron on a main bundle with inherited stdio and this host's sandbox switches.
 *
 * @param {string} mainFile the main bundle (`dist/app/main.js`)
 * @param {NodeJS.ProcessEnv} [environment] the child environment (default: this process's)
 * @return {import("node:child_process").ChildProcess} the Electron process
 */
function spawnApp(mainFile, environment = process.env) {
  const binary = electronBinary()
  return spawn(binary, [mainFile, ...sandboxSwitches(binary)], { stdio: "inherit", env: environment })
}

module.exports = {
  NoSandboxSwitch,
  UserNamespaceRestrictionFile,
  electronBinary,
  hasSetUidHelper,
  hasUserNamespaces,
  sandboxSwitches,
  spawnApp
}
