import { act } from "react"
import TestRenderer from "react-test-renderer"

import {
  createTuiStore,
  StoreService,
  TuiServiceId,
  TuiServiceProvider,
  TuiServiceRegistry,
  useTuiService,
  useTuiServiceRegistry
} from "@wireio/ql-tool-cli/tui/index.js"

/** Records what the hooks return. */
const seen: unknown[] = []

/** Reads a service and the registry. */
function Reader() {
  seen.push(useTuiService(TuiServiceId.store), useTuiServiceRegistry())
  return null
}

describe("TuiServiceContext", () => {
  it("returns the registered service and the registry inside the provider", () => {
    const service = new StoreService(),
      registry = new TuiServiceRegistry().register(service)
    act(() => {
      TestRenderer.create(
        <TuiServiceProvider registry={registry}>
          <Reader />
        </TuiServiceProvider>
      )
    })
    expect(seen).toEqual([service, registry])
  })

  it("throws outside the provider", () => {
    const Bare = () => {
      useTuiService(TuiServiceId.store)
      return null
    }
    expect(() => act(() => void TestRenderer.create(<Bare />))).toThrow(/outside a TuiServiceProvider/)
  })

  it("StoreService seeds the boot profile", async () => {
    const store = createTuiStore(),
      profile = { name: "p", endpoint: "http://e.example", transportTimeoutMs: 1, retries: 0 },
      service = new StoreService()
    await service.start({ store, profile, registry: new TuiServiceRegistry() })
    await service.stop()
    expect(store.getState().connection.profile).toEqual(profile)
    expect(service.dependsOn).toEqual([])
  })
})
