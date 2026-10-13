import Fs from "node:fs"
import Path from "node:path"

import { TempDirectory } from "../../common/TempDirectory.js"
import { ElectronSandbox } from "./ElectronSandbox.js"

/** The setuid sandbox helper's file name next to the Electron executable. */
const SandboxHelperFilename = "chrome-sandbox"
/** A setuid, world-executable mode. */
const SetUidMode = 0o4755
/** A stand-in Electron executable name inside a temp directory. */
const ElectronFilename = "electron"
/** The platform whose OS sandbox depends on user namespaces / the setuid helper. */
const LinuxPlatform = "linux"
/** uid of root. */
const RootUid = 0

describe("ElectronSandbox", () => {
  const { Launcher } = ElectronSandbox

  afterEach(() => TempDirectory.removeAll())

  it("reads the shared launcher module that start and dev use", () => {
    expect(Fs.existsSync(ElectronSandbox.LauncherFile)).toBe(true)
    expect(Launcher.NoSandboxSwitch).toBe("--no-sandbox")
  })

  it("adds --no-sandbox only when neither user namespaces nor a setuid helper exist", () => {
    const electronBinary = Path.join(TempDirectory.create(), ElectronFilename),
      expected =
        process.platform === LinuxPlatform && !Launcher.hasUserNamespaces() ? [Launcher.NoSandboxSwitch] : []
    expect(Launcher.hasSetUidHelper(electronBinary)).toBe(false)
    expect(ElectronSandbox.switches(electronBinary)).toEqual(expected)
  })

  it("does not treat a setuid helper owned by a non-root user as usable", () => {
    const directory = TempDirectory.create(),
      helper = Path.join(directory, SandboxHelperFilename)
    Fs.writeFileSync(helper, "")
    Fs.chmodSync(helper, SetUidMode)
    expect(Launcher.hasSetUidHelper(Path.join(directory, ElectronFilename))).toBe(process.getuid() === RootUid)
  })
})
