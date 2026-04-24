import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import {
  LogTailingEvent,
  LogTailingService
} from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/LogTailingService.js"
import { ProcessMonitorService } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/ProcessMonitorService.js"
import { ReduxService } from "@wire-e2e-tests/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceId } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceId.js"
import { ServiceManager } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceManager.js"
import { setLogViewerPath } from "@wire-e2e-tests/debugging-client-tool-tui/store/processMonitor/ProcessMonitorSlice.js"
import { store } from "@wire-e2e-tests/debugging-client-tool-tui/store/Store.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-svc-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
})

async function waitForRuntime(
  svc: LogTailingService,
  predicate: (r: { totalLines: number; indexing: boolean }) => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate(svc.getRuntime())) return resolve()
      if (Date.now() > deadline) return reject(new Error("timeout"))
      setTimeout(check, 10)
    }
    check()
  })
}

describe("LogTailingService static shape", () => {
  it("id/depends/category/pollMs constants", () => {
    expect(LogTailingService.id).toBe(ServiceId.LogTailing)
    expect(LogTailingService.dependsOn).toEqual([
      ServiceId.Redux,
      ServiceId.ProcessMonitor
    ])
    expect(LogTailingService.Category).toBe("tui:log-tailing")
    expect(LogTailingService.PollMs).toBe(200)
  })
})

describe("LogTailingService runtime", () => {
  it("indexes the selected log file + serves readWindow", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-cluster-"))
    const logFile = Path.join(root, "app.log")
    Fs.writeFileSync(logFile, "l1\nl2\nl3\n")

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()

    store.dispatch(setLogViewerPath(logFile))
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    await waitForRuntime(svc, r => r.totalLines === 3 && !r.indexing)
    expect(await svc.readWindow(0, 2)).toEqual(["l1", "l2"])
    expect(await svc.readWindow(2, 5)).toEqual(["l3"])

    await sm.destroy()
  })

  it("getRuntime returns zeros before any path is selected", async () => {
    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    expect(svc.getRuntime()).toEqual({ totalLines: 0, totalBytes: 0, indexing: false })
    await sm.destroy()
  })

  it("emits LogTailingEvent when the path changes", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-ev-"))
    const logFile = Path.join(root, "app.log")
    Fs.writeFileSync(logFile, "x\n")

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    let fired = 0
    svc.on(LogTailingEvent, () => {
      fired += 1
    })
    store.dispatch(setLogViewerPath(logFile))
    await waitForRuntime(svc, r => r.totalLines === 1)
    expect(fired).toBeGreaterThan(0)
    await sm.destroy()
  })
})
