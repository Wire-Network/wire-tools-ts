import Os from "node:os"

import { createQLPathsDefaultOptions, QLPaths, QLPlatform } from "@wireio/ql-shared/node"

const homePath = "/home/user"

describe("QLPaths", () => {
  it("linux: XDG directories with ~/.config and ~/.local/state fallbacks", () => {
    expect(QLPaths.configPath({ platform: "linux", environment: {}, homePath })).toBe("/home/user/.config/wire-ql")
    expect(QLPaths.configPath({ platform: "linux", environment: { XDG_CONFIG_HOME: "/xdg/config" }, homePath })).toBe("/xdg/config/wire-ql")
    expect(QLPaths.statePath({ platform: "linux", environment: {}, homePath })).toBe("/home/user/.local/state/wire-ql")
    expect(QLPaths.statePath({ platform: "linux", environment: { XDG_STATE_HOME: "/xdg/state" }, homePath })).toBe("/xdg/state/wire-ql")
  })

  it("macOS: Application Support and Logs", () => {
    expect(QLPaths.configPath({ platform: "darwin", environment: {}, homePath })).toBe("/home/user/Library/Application Support/wire-ql")
    expect(QLPaths.statePath({ platform: "darwin", environment: {}, homePath })).toBe("/home/user/Library/Logs/wire-ql")
  })

  it("Windows: APPDATA and LOCALAPPDATA with win32 separators", () => {
    const environment = { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }
    expect(QLPaths.configPath({ platform: "win32", environment, homePath: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming\\wire-ql")
    expect(QLPaths.statePath({ platform: "win32", environment, homePath: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Local\\wire-ql")
    expect(QLPaths.configPath({ platform: "win32", environment: {}, homePath: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming\\wire-ql")
  })

  it("places the documents and logs", () => {
    const options = { platform: QLPlatform.linux, environment: {}, homePath }
    expect(QLPaths.profilesFile(options)).toBe("/home/user/.config/wire-ql/profiles.json")
    expect(QLPaths.savedQueriesFile(options)).toBe("/home/user/.config/wire-ql/saved-queries.json")
    expect(QLPaths.historyFile(options)).toBe("/home/user/.local/state/wire-ql/history.jsonl")
    expect(QLPaths.logsPath(options)).toBe("/home/user/.local/state/wire-ql/logs")
  })

  it("createQLPathsDefaultOptions() is the current process's environment, platform and home", () => {
    expect(createQLPathsDefaultOptions()).toEqual({ environment: process.env, platform: process.platform, homePath: Os.homedir() })
  })

  it("defaults to the current process; an explicit undefined keeps a default", () => {
    expect(QLPaths.configPath().endsWith(QLPaths.AppDirectoryName)).toBe(true)
    expect(QLPaths.configPath({ platform: QLPlatform.darwin, environment: {}, homePath: undefined })).toBe(
      `${Os.homedir()}/Library/Application Support/wire-ql`
    )
  })

  it("names the platforms with their own conventions by their process.platform spelling", () => {
    Object.entries(QLPlatform).forEach(([key, value]) => expect(value).toBe(key))
    expect(Object.values(QLPlatform)).toEqual(["linux", "darwin", "win32"])
    expect(Object.values(QLPlatform)).toContain(process.platform)
  })
})
