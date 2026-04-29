import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { ProcessMonitorService } from "@wireio/debugging-client-tool-tui/features/process-monitor/ProcessMonitorService.js"
import { ReduxService } from "@wireio/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceId } from "@wireio/debugging-client-tool-tui/services/ServiceId.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"
import { setCluster } from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSlice.js"
import { store } from "@wireio/debugging-client-tool-tui/store/Store.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "pm-svc-"))

function clusterWithNode(nodePidLabel: string) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "pm-svc-cluster-"))
  const dataPath = Path.join(root, "data/node_00")
  Fs.mkdirSync(dataPath, { recursive: true })
  // Use our own pid — guaranteed alive.
  Fs.writeFileSync(
    Path.join(dataPath, `${nodePidLabel}.pid`),
    String(process.pid)
  )
  return { root, dataPath }
}

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
})

describe("ProcessMonitorService static shape", () => {
  it("id = ServiceId.ProcessMonitor, depends on Redux", () => {
    expect(ProcessMonitorService.id).toBe(ServiceId.ProcessMonitor)
    expect(ProcessMonitorService.dependsOn).toEqual([ServiceId.Redux])
  })

  it("namespace exposes PollIntervalMs + Category", () => {
    expect(ProcessMonitorService.PollIntervalMs).toBe(5_000)
    expect(ProcessMonitorService.Category).toBe("tui:process-monitor")
  })
})

describe("ProcessMonitorService.listSources", () => {
  it("returns [] when no cluster is loaded", async () => {
    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
    await sm.boot()
    store.dispatch(
      setCluster({
        path: "/tmp/nonexistent-xyz",
        config: {} as any,
        state: null
      })
    )
    const svc = sm.get<ProcessMonitorService>(ServiceId.ProcessMonitor)
    expect(svc.listSources()).toEqual([])
    await sm.destroy()
  })

  it("returns pid-file-backed sources under the loaded cluster", async () => {
    const { root, dataPath } = clusterWithNode("node-00")
    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(ProcessMonitorService)
    await sm.boot()
    store.dispatch(
      setCluster({
        path: root,
        config: {} as any,
        state: {
          nodes: [
            {
              nodeId: 0,
              host: "127.0.0.1",
              port: 8888,
              dataPath,
              configPath: dataPath,
              cmd: [],
              isProducer: true,
              producerName: null,
              role: "producer" as any
            }
          ],
          batchOperatorNodes: [],
          underwriterNodes: []
        } as any
      })
    )
    const sources = sm
      .get<ProcessMonitorService>(ServiceId.ProcessMonitor)
      .listSources()
    expect(sources.map(s => s.label)).toEqual(["node-00"])
    await sm.destroy()
  })
})
