import {
  createTuiStore,
  TuiServiceId,
  TuiServiceRegistry,
  type TuiService,
  type TuiServiceStartContext
} from "@wireio/ql-tool-cli/tui/index.js"

/** A recording fake service. */
function fake(id: TuiServiceId, dependsOn: TuiServiceId[], log: string[], failStart = false): TuiService {
  return {
    id,
    dependsOn,
    start: async (context: TuiServiceStartContext) => {
      if (failStart) throw new Error(`${id} broke`)
      log.push(`start ${id} ${context.registry.order.length}`)
    },
    stop: async () => {
      log.push(`stop ${id}`)
    }
  }
}

const boot = () => ({ store: createTuiStore(), profile: { name: "p", endpoint: "http://e.example", transportTimeoutMs: 1, retries: 0 } })

describe("TuiServiceRegistry", () => {
  it("is an identity-enum keyed registry", () => {
    Object.entries(TuiServiceId).forEach(([name, value]) => expect(value).toBe(name))
  })

  it("starts in dependency (registration) order and stops in reverse", async () => {
    const log: string[] = [],
      registry = new TuiServiceRegistry()
        .register(fake(TuiServiceId.store, [], log))
        .register(fake(TuiServiceId.persistence, [TuiServiceId.store], log))
        .register(fake(TuiServiceId.query, [TuiServiceId.persistence], log))
    await registry.startAll(boot())
    await registry.stopAll()
    expect(log).toEqual(["start store 3", "start persistence 3", "start query 3", "stop query", "stop persistence", "stop store"])
    expect(registry.get(TuiServiceId.query).id).toBe(TuiServiceId.query)
  })

  it("throws at registration on an unknown dependency, a self-dependency (cycle) or a duplicate", () => {
    const registry = new TuiServiceRegistry()
    expect(() => registry.register(fake(TuiServiceId.query, [TuiServiceId.catalog], []))).toThrow(/unregistered services: catalog/)
    expect(() => registry.register(fake(TuiServiceId.store, [TuiServiceId.store], []))).toThrow(/cycle/)
    registry.register(fake(TuiServiceId.store, [], []))
    expect(() => registry.register(fake(TuiServiceId.store, [], []))).toThrow(/already registered/)
    expect(() => registry.get(TuiServiceId.catalog)).toThrow(/not registered/)
  })

  it("stops the started services and rethrows when a start fails", async () => {
    const log: string[] = [],
      registry = new TuiServiceRegistry().register(fake(TuiServiceId.store, [], log)).register(fake(TuiServiceId.query, [TuiServiceId.store], log, true))
    await expect(registry.startAll(boot())).rejects.toThrow(/starting TUI service query failed/)
    expect(log).toEqual(["start store 2", "stop store"])
  })

  it("collects stop failures", async () => {
    const registry = new TuiServiceRegistry().register({ ...fake(TuiServiceId.store, [], []), stop: () => Promise.reject(new Error("x")) })
    await registry.startAll(boot())
    await expect(registry.stopAll()).rejects.toThrow(/stopping TUI services failed/)
  })
})
