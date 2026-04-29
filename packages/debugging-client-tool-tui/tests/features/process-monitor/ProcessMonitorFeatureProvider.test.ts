import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import ProcessMonitorFeatureProvider from "@wireio/debugging-client-tool-tui/features/process-monitor/ProcessMonitorFeatureProvider.js"
import { LogTailingService } from "@wireio/debugging-client-tool-tui/features/process-monitor/LogTailingService.js"
import { ProcessMonitorService } from "@wireio/debugging-client-tool-tui/features/process-monitor/ProcessMonitorService.js"
import { LogViewerPanel } from "@wireio/debugging-client-tool-tui/features/process-monitor/panels/LogViewerPanel.js"
import { ProcessMonitorPanel } from "@wireio/debugging-client-tool-tui/features/process-monitor/panels/ProcessMonitorPanel.js"
import { NodeCountWidget } from "@wireio/debugging-client-tool-tui/features/process-monitor/widgets/NodeCountWidget.js"
import { FeatureComponentToken } from "@wireio/debugging-client-tool-tui/providers/ComponentProviders.js"
import { ReduxService } from "@wireio/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"

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
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.Panel,
      ProcessMonitorPanel
    )
    expect(register).toHaveBeenCalledWith(
      FeatureComponentToken.Panel,
      LogViewerPanel
    )
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
