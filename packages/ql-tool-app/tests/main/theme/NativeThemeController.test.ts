import Fs from "node:fs"
import Path from "node:path"

import { ThemeSource } from "@wireio/ql-tool-app/common"
import { NativeThemeController } from "@wireio/ql-tool-app/main/theme"

import { nativeTheme } from "../../__mocks__/electron.js"
import { TempDirectory } from "../../common/TempDirectory.js"

beforeEach(() => {
  nativeTheme.themeSource = ThemeSource.system
})

describe("NativeThemeController", () => {
  it("set applies and persists; a new controller restores it", () => {
    const userDataPath = TempDirectory.create()
    new NativeThemeController(userDataPath).set(ThemeSource.dark)
    expect(nativeTheme.themeSource).toBe(ThemeSource.dark)
    nativeTheme.themeSource = ThemeSource.system
    const restored = new NativeThemeController(userDataPath)
    restored.restore()
    expect(restored.source).toBe(ThemeSource.dark)
  })

  it("restore falls back to system when the file is absent or corrupt", () => {
    const userDataPath = TempDirectory.create(),
      controller = new NativeThemeController(userDataPath)
    nativeTheme.themeSource = ThemeSource.light
    controller.restore()
    expect(nativeTheme.themeSource).toBe(ThemeSource.system)
    Fs.writeFileSync(Path.join(userDataPath, NativeThemeController.Filename), '{"themeSource":"neon"}')
    nativeTheme.themeSource = ThemeSource.light
    controller.restore()
    expect(nativeTheme.themeSource).toBe(ThemeSource.system)
  })

  it("defaultDocument is the system appearance", () => {
    expect(NativeThemeController.defaultDocument()).toEqual({ themeSource: ThemeSource.system })
  })
})
