import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"
import type { Service } from "@wireio/debugging-client-tool-tui/services/Service.js"
import type { ServiceManager as ServiceManagerType } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "tui-sm-test-"))

/**
 * Shared call-order log across every stub in a test. Each `makeServiceType`
 * pushes `"phase:id"` strings to its `calls` array AND to `sharedCalls` when
 * provided, letting tests assert inter-service ordering (init across all
 * services happens before any start).
 */
const sharedCalls: string[] = []

/** Minimal stub Service — records lifecycle invocations for later assertions. */
function makeServiceType(
  id: string,
  dependsOn: readonly string[] = [],
  sink: string[] = sharedCalls
) {
  const calls: string[] = []
  class StubService implements Service {
    static readonly id = id
    static readonly dependsOn = dependsOn
    async init(_: ServiceManagerType): Promise<Service> {
      calls.push(`init:${id}`)
      sink.push(`init:${id}`)
      return this
    }
    async start(_: ServiceManagerType): Promise<Service> {
      calls.push(`start:${id}`)
      sink.push(`start:${id}`)
      return this
    }
    async stop(_: ServiceManagerType): Promise<Service> {
      calls.push(`stop:${id}`)
      sink.push(`stop:${id}`)
      return this
    }
  }
  return { type: StubService, calls }
}

function makeFailingStopServiceType(id: string, errorMessage: string) {
  class FailStopService implements Service {
    static readonly id = id
    static readonly dependsOn: readonly string[] = []
    async init(_: ServiceManagerType): Promise<Service> {
      return this
    }
    async start(_: ServiceManagerType): Promise<Service> {
      return this
    }
    async stop(_: ServiceManagerType): Promise<Service> {
      throw new Error(errorMessage)
    }
  }
  return FailStopService
}

beforeAll(() => {
  LoggingManager.configure({
    filename: Path.join(logDir, "tui.log"),
    level: Level.fatal
  })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
  sharedCalls.length = 0
})

describe("ServiceManager.register", () => {
  it("throws on duplicate id", () => {
    const { type: A } = makeServiceType("a")
    const sm = ServiceManager.get()
    sm.register(A)
    expect(() => sm.register(A)).toThrow(/already registered/)
  })

  it("throws when a declared dep is not yet registered", () => {
    const { type: B } = makeServiceType("b", ["a"])
    const sm = ServiceManager.get()
    expect(() => sm.register(B)).toThrow(/depends on "a"/)
  })

  it("throws after boot has begun (configurable=false)", async () => {
    const { type: A } = makeServiceType("a")
    const { type: B } = makeServiceType("b")
    const sm = ServiceManager.get()
    sm.register(A)
    await sm.boot()
    expect(() => sm.register(B)).toThrow(/already booted/)
    await sm.destroy()
  })
})

describe("ServiceManager.serviceRecordsByBootOrder", () => {
  it("produces topological order respecting dependsOn", () => {
    const { type: A } = makeServiceType("a")
    const { type: B } = makeServiceType("b", ["a"])
    const { type: C } = makeServiceType("c", ["b", "a"])
    const sm = ServiceManager.get()
    sm.register(A).register(B).register(C)
    const ids = sm.serviceRecordsByBootOrder.map(r => r.id)
    expect(ids).toEqual(["a", "b", "c"])
  })
})

describe("ServiceManager.boot + destroy", () => {
  it("init then start in topological order; stop in reverse", async () => {
    const a = makeServiceType("a")
    const b = makeServiceType("b", ["a"])
    const c = makeServiceType("c", ["b"])
    const sm = ServiceManager.get()
    sm.register(a.type).register(b.type).register(c.type)
    await sm.boot()
    expect(sharedCalls).toEqual([
      "init:a",
      "init:b",
      "init:c",
      "start:a",
      "start:b",
      "start:c"
    ])
    await sm.destroy()
    expect(sharedCalls.slice(6)).toEqual(["stop:c", "stop:b", "stop:a"])
  })

  it("aggregates stop errors and still resets to configurable state", async () => {
    const A = makeFailingStopServiceType("a", "boom-a")
    const B = makeFailingStopServiceType("b", "boom-b")
    const sm = ServiceManager.get()
    sm.register(A).register(B)
    await sm.boot()
    await expect(sm.destroy()).rejects.toBeInstanceOf(AggregateError)
    // after destroy, we can boot again without re-registering — the
    // registry persists but the service slots were nulled out.
    await expect(sm.boot()).resolves.toBeUndefined()
    await sm.destroy().catch(() => {}) // tolerate the same failure on teardown
  })

  it("rejects a second boot call", async () => {
    const { type: A } = makeServiceType("a")
    const sm = ServiceManager.get()
    sm.register(A)
    await sm.boot()
    await expect(sm.boot()).rejects.toThrow(/not configurable/)
    await sm.destroy()
  })
})

describe("ServiceManager.get<T>", () => {
  it("throws for unregistered ids", () => {
    const sm = ServiceManager.get()
    expect(() => sm.get("missing")).toThrow(/not registered/)
  })

  it("throws for registered-but-unbooted services", () => {
    const { type: A } = makeServiceType("a")
    const sm = ServiceManager.get()
    sm.register(A)
    expect(() => sm.get("a")).toThrow(/not been booted/)
  })

  it("returns the service instance after boot", async () => {
    const { type: A } = makeServiceType("a")
    const sm = ServiceManager.get()
    sm.register(A)
    await sm.boot()
    expect(sm.get("a")).toBeInstanceOf(A)
    await sm.destroy()
  })
})

describe("ServiceManager cycle detection", () => {
  it("throws on a direct cycle", () => {
    // We can't register a cycle because register resolves deps eagerly.
    // To exercise the topological detector, bypass registration by poking
    // the internal map through destroy-reset cycles — simplest reliable test:
    // manually build a map then call serviceRecordsByBootOrder.
    const sm = ServiceManager.get() as any
    const recA: any = {
      id: "a",
      serviceType: { id: "a" },
      service: null,
      dependsOn: []
    }
    const recB: any = {
      id: "b",
      serviceType: { id: "b" },
      service: null,
      dependsOn: []
    }
    recA.dependsOn = [recB]
    recB.dependsOn = [recA]
    sm.serviceRecordMap.set("a", recA)
    sm.serviceRecordMap.set("b", recB)
    expect(() => sm.serviceRecordsByBootOrder).toThrow(/Cycle detected/)
  })
})
