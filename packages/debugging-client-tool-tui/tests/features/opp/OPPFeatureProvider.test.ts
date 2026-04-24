import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import OPPFeatureProvider from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/OPPFeatureProvider.js"
import { OPPTrackingService } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/OPPTrackingService.js"
import { EpochTrackerPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/panels/EpochTrackerPanel.js"
import { EpochStatusBarWidget } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/widgets/EpochStatusBarWidget.js"
import { FeatureComponentToken } from "@wire-e2e-tests/debugging-client-tool-tui/providers/ComponentProviders.js"
import { ReduxService } from "@wire-e2e-tests/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceManager } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceManager.js"

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
    expect(register).toHaveBeenCalledWith(FeatureComponentToken.Panel, EpochTrackerPanel)
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.StatusBar,
      EpochStatusBarWidget
    )
  })
})

describe("OPPFeatureProvider.registerServices", () => {
  it("registers the OPPTrackingService with the manager", () => {
    // OPPTrackingService dependsOn [Redux], so register Redux first.
    const manager = ServiceManager.get().register(ReduxService)
    OPPFeatureProvider.registerServices(manager)
    expect(manager.find(OPPTrackingService.id)?.serviceType).toBe(
      OPPTrackingService
    )
  })
})
