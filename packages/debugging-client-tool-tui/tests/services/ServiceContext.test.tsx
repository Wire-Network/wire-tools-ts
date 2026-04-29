import React from "react"
import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import {
  ServiceManagerContext,
  ServiceManagerProvider,
  useService,
  useServiceManager,
  useServices
} from "@wireio/debugging-client-tool-tui/services/ServiceContext.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"
import type { Service } from "@wireio/debugging-client-tool-tui/services/Service.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "svc-ctx-"))

class StubA implements Service {
  static readonly id = "a"
  static readonly dependsOn: readonly string[] = []
  tag = "a"
  async init(): Promise<Service> {
    return this
  }
  async start(): Promise<Service> {
    return this
  }
  async stop(): Promise<Service> {
    return this
  }
}

class StubB implements Service {
  static readonly id = "b"
  static readonly dependsOn: readonly string[] = []
  tag = "b"
  async init(): Promise<Service> {
    return this
  }
  async start(): Promise<Service> {
    return this
  }
  async stop(): Promise<Service> {
    return this
  }
}

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
})

describe("ServiceManagerContext", () => {
  it("default value is null — makes the useServiceManager guard meaningful", () => {
    // The Context's `_currentValue` isn't public, but consumers can spy via React.useContext
    // outside a Provider. We simulate by directly reading the context's internal default.
    // This asserts the invariant we designed around: default null → thrown error.
    const ctx: any = ServiceManagerContext
    expect(ctx._currentValue).toBeNull()
  })
})

/**
 * Mock React.useContext to drive the hooks without a real renderer.
 * This isolates our hook logic without adding a React DOM testing dep.
 */
function withMockedContext<T>(value: ServiceManager | null, body: () => T): T {
  const spy = jest.spyOn(React, "useContext").mockImplementation(() => value)
  try {
    return body()
  } finally {
    spy.mockRestore()
  }
}

describe("useServiceManager", () => {
  it("returns the manager when context is populated", async () => {
    const sm = ServiceManager.get()
    const result = withMockedContext(sm, () => useServiceManager())
    expect(result).toBe(sm)
  })

  it("throws when context is null (no provider)", () => {
    expect(() => withMockedContext(null, () => useServiceManager())).toThrow(
      /outside a ServiceManagerContext.Provider/
    )
  })
})

describe("useService", () => {
  it("returns the booted service by id", async () => {
    const sm = ServiceManager.get().register(StubA)
    await sm.boot()
    const result = withMockedContext(sm, () => useService<StubA>("a"))
    expect(result).toBeInstanceOf(StubA)
    await sm.destroy()
  })
})

describe("useServices", () => {
  it("returns multiple services in tuple order", async () => {
    const sm = ServiceManager.get().register(StubA).register(StubB)
    await sm.boot()
    const [a, b] = withMockedContext(sm, () =>
      useServices<[StubA, StubB]>("a", "b")
    )
    expect(a.tag).toBe("a")
    expect(b.tag).toBe("b")
    await sm.destroy()
  })
})

describe("ServiceManagerProvider", () => {
  it("is a valid React component that wraps children in the context", () => {
    const sm = ServiceManager.get()
    const element = (
      <ServiceManagerProvider manager={sm}>
        <span>child</span>
      </ServiceManagerProvider>
    )
    expect(element.props.manager).toBe(sm)
    expect((element.type as Function).name).toBe("ServiceManagerProvider")
  })
})
