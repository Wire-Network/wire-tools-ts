import Path from "node:path"

import { AppPaths } from "@wireio/ql-tool-app/main"

import { RendererFixtures } from "../common/RendererFixtures.js"

/** Fixture constants. */
namespace Fixture {
  export const AppPath = "/opt/wire-ql/resources/app.asar"
}

describe("AppPaths.resolve", () => {
  it("places every bundle file next to main.js and loads the renderer from file://", () => {
    expect(AppPaths.resolve(Fixture.AppPath, {})).toEqual({
      preloadFile: Path.join(Fixture.AppPath, AppPaths.PreloadFilename),
      hostModuleFile: Path.join(Fixture.AppPath, AppPaths.HostModuleFilename),
      rendererURL: `file://${Path.join(Fixture.AppPath, AppPaths.RendererSubpath, AppPaths.RendererFilename)}`,
      iconFile: Path.join(Fixture.AppPath, AppPaths.AssetsSubpath, AppPaths.IconFilename)
    })
  })

  it("the dev-server variable redirects only the renderer URL", () => {
    const paths = AppPaths.resolve(Fixture.AppPath, {
      [AppPaths.DevServerURLEnvironmentVariable]: RendererFixtures.DevServerURL
    })
    expect(paths.rendererURL).toBe(RendererFixtures.DevServerURL)
    expect(paths.preloadFile).toBe(Path.join(Fixture.AppPath, AppPaths.PreloadFilename))
  })
})

describe("AppPaths constants", () => {
  it("names the main bundle and the environment that relocates the app", () => {
    expect(AppPaths.MainFilename).toBe("main.js")
    expect(AppPaths.UserDataEnvironmentVariable).toBe("WIRE_QL_USER_DATA_PATH")
    expect(AppPaths.DevServerURLEnvironmentVariable).toBe("WIRE_QL_DEV_SERVER_URL")
  })
})
