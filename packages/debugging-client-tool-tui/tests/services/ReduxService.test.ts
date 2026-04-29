import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { ReduxService } from "@wireio/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceId } from "@wireio/debugging-client-tool-tui/services/ServiceId.js"
import { store } from "@wireio/debugging-client-tool-tui/store/Store.js"

const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "redux-svc-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: dir, level: Level.fatal })
})

describe("ReduxService static shape", () => {
  it("declares ServiceId.Redux as its id", () => {
    expect(ReduxService.id).toBe(ServiceId.Redux)
  })

  it("has no declared dependencies", () => {
    expect(ReduxService.dependsOn).toEqual([])
  })
})

describe("ReduxService instance", () => {
  const svc = new ReduxService()

  it("init/start/stop resolve to the instance (no-ops)", async () => {
    await expect(svc.init(null as any)).resolves.toBe(svc)
    await expect(svc.start(null as any)).resolves.toBe(svc)
    await expect(svc.stop(null as any)).resolves.toBe(svc)
  })

  it("exposes the shared store", () => {
    expect(svc.store).toBe(store)
  })

  it("dispatch + getState proxy to the store", () => {
    const before = svc.getState()
    svc.dispatch({ type: "__test_noop__" })
    const after = svc.getState()
    expect(after).toEqual(before)
  })

  it("subscribe fires listener after a dispatched action and the returned thunk detaches it", () => {
    let hits = 0
    const unsubscribe = svc.subscribe(() => {
      hits += 1
    })
    svc.dispatch({ type: "__test_ping__" })
    expect(hits).toBe(1)
    unsubscribe()
    svc.dispatch({ type: "__test_ping__" })
    expect(hits).toBe(1) // no more hits after unsubscribe
  })
})
