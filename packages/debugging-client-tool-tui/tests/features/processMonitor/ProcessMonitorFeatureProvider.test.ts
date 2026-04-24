import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import ProcessMonitorFeatureProvider from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/ProcessMonitorFeatureProvider.js"
import { LogTailingService } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/LogTailingService.js"
import { ProcessMonitorService } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/ProcessMonitorService.js"
import { LogViewerPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/panels/LogViewerPanel.js"
import { ProcessMonitorPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/panels/ProcessMonitorPanel.js"
import { NodeCountWidget } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/widgets/NodeCountWidget.js"
import { FeatureComponentToken } from "@wire-e2e-tests/debugging-client-tool-tui/providers/ComponentProviders.js"
import { ReduxService } from "@wire-e2e-tests/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceManager } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceManager.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "pm-fp-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
})

describe("ProcessMonitorFeatureProvider metadata", () => {
  it("is marked as required (always-on)", () => {
    expect(ProcessMonitorFeatureProvider.id).toBe("process-monitor")
    expect(ProcessMonitorFeatureProvider.name).toBe("Process Monitor")
    expect(ProcessMonitorFeatureProvider.isRequiredProvider).toBe(true)
  })
})

describe("ProcessMonitorFeatureProvider.registerComponents", () => {
  it("installs both panels + the node-count widget", () => {
    const register = jest.fn()
    ProcessMonitorFeatureProvider.registerComponents({ register } as any)
    expect(register).toHaveBeenCalledWith(FeatureComponentToken.Panel, ProcessMonitorPanel)
    expect(register).toHaveBeenCalledWith(FeatureComponentToken.Panel, LogViewerPanel)
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.StatusBar,
      NodeCountWidget
    )
  })
})

describe("ProcessMonitorFeatureProvider.registerServices", () => {
  it("registers ProcessMonitor before LogTailing (dep order)", () => {
    const manager = ServiceManager.get().register(ReduxService)
    ProcessMonitorFeatureProvider.registerServices(manager)
    expect(manager.find(ProcessMonitorService.id)).toBeDefined()
    expect(manager.find(LogTailingService.id)).toBeDefined()
  })
})
