import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import OPPFeatureProvider from "@wireio/debugging-client-tool-tui/features/opp/OPPFeatureProvider.js"
import { OPPTrackingService } from "@wireio/debugging-client-tool-tui/features/opp/OPPTrackingService.js"
import { EpochTrackerPanel } from "@wireio/debugging-client-tool-tui/features/opp/panels/EpochTrackerPanel.js"
import { EpochDetailRoute } from "@wireio/debugging-client-tool-tui/features/opp/routes/EpochDetailRoute.js"
import { EpochStatusBarWidget } from "@wireio/debugging-client-tool-tui/features/opp/widgets/EpochStatusBarWidget.js"
import { FeatureComponentToken } from "@wireio/debugging-client-tool-tui/providers/ComponentProviders.js"
import { DebuggingClientService } from "@wireio/debugging-client-tool-tui/services/DebuggingClientService.js"
import { ReduxService } from "@wireio/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"
import { MockDebuggingClient } from "../MockDebuggingClient.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-fp-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
})

describe("OPPFeatureProvider metadata", () => {
  it("exposes stable id/name/required flag", () => {
    expect(OPPFeatureProvider.id).toBe("opp")
    expect(OPPFeatureProvider.name).toBe("OPP")
    expect(OPPFeatureProvider.isRequiredProvider).toBe(false)
  })
})

describe("OPPFeatureProvider.registerComponents", () => {
  it("registers the epoch-tracker panel and epoch status-bar widget", () => {
    const register = jest.fn()
    OPPFeatureProvider.registerComponents({ register } as any)
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.Panel,
      EpochTrackerPanel
    )
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.StatusBar,
      EpochStatusBarWidget
    )
  })
})

describe("OPPFeatureProvider.registerServices", () => {
  it("registers the OPPTrackingService with the manager", () => {
    // OPPTrackingService dependsOn [Redux, DebuggingClient]; register both first.
    const manager = ServiceManager.get().register(ReduxService)
    manager.registerInstance(
      new DebuggingClientService(new MockDebuggingClient() as any)
    )
    OPPFeatureProvider.registerServices(manager)
    expect(manager.find(OPPTrackingService.id)?.serviceType).toBe(
      OPPTrackingService
    )
  })
})

describe("OPPFeatureProvider.registerRoutes", () => {
  it("registers both the cyclable tracker route and the non-cyclable detail route", () => {
    const register = jest.fn()
    OPPFeatureProvider.registerRoutes({ register } as any)
    const calls = register.mock.calls.map(c => c[0])
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: OPPFeatureProvider.RoutePath,
          cyclable: true
        }),
        expect.objectContaining({
          path: EpochDetailRoute.RoutePath,
          cyclable: false
        })
      ])
    )
  })
})
