import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import {
  LogTailingEventName,
  LogTailingService,
  type LogTailingRuntime
} from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/LogTailingService.js"
import { ProcessMonitorService } from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/ProcessMonitorService.js"
import { ReduxService } from "@wire-e2e-tests/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceId } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceId.js"
import { ServiceManager } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceManager.js"
import { setLogViewerPath } from "@wire-e2e-tests/debugging-client-tool-tui/store/process-monitor/ProcessMonitorSlice.js"
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
  it("readWindow excludes the in-progress trailing line (no `\\n`)", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-partial-"))
    const logFile = Path.join(root, "app.log")
    // Two complete lines + a partial third; the partial mustn't reach the
    // renderer (would parse as malformed JSON in JSONL mode).
    Fs.writeFileSync(logFile, "l1\nl2\npartial")

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()

    store.dispatch(setLogViewerPath(logFile))
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    await waitForRuntime(svc, r => r.totalLines === 2 && !r.indexing)
    expect(await svc.readWindow(0, 10)).toEqual(["l1", "l2"])
    // Asking explicitly for the partial-line index returns nothing.
    expect(await svc.readWindow(2, 1)).toEqual([])

    await sm.destroy()
  })

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

  it("emits typed Update event with the runtime payload when the path changes", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-ev-"))
    const logFile = Path.join(root, "app.log")
    Fs.writeFileSync(logFile, "x\n")

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    const updates: LogTailingRuntime[] = []
    svc.on(LogTailingEventName.Update, runtime => {
      updates.push(runtime)
    })
    store.dispatch(setLogViewerPath(logFile))
    await waitForRuntime(svc, r => r.totalLines === 1)
    expect(updates.length).toBeGreaterThan(0)
    // At least one emission carried a non-indexing snapshot with the actual line count.
    expect(updates.some(u => u.totalLines === 1 && u.indexing === false)).toBe(
      true
    )
    await sm.destroy()
  })

  it("emits PathChanged with the new path when the user selects a log", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "log-tail-pc-"))
    const logFile = Path.join(root, "app.log")
    Fs.writeFileSync(logFile, "x\n")

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
      .register(LogTailingService)
    await sm.boot()
    const svc = sm.get<LogTailingService>(ServiceId.LogTailing)
    const pathChanges: (string | null)[] = []
    svc.on(LogTailingEventName.PathChanged, p => {
      pathChanges.push(p)
    })
    store.dispatch(setLogViewerPath(logFile))
    await waitForRuntime(svc, r => r.totalLines === 1)
    expect(pathChanges).toContain(logFile)
    store.dispatch(setLogViewerPath(null))
    expect(pathChanges).toContain(null)
    await sm.destroy()
  })
})
