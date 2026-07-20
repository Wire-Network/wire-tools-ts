import {
  ClusterBuildContext,
  OutputStore
} from "@wireio/cluster-tool/orchestration"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  fixtureConfig,
  PersistedFixture
} from "../config/clusterConfigFixture.js"

function newContext(): ClusterBuildContext {
  return new ClusterBuildContext(fixtureConfig(), getLogger("ctx-test"))
}

describe("ClusterBuildContext", () => {
  it("exposes the resolved config + a typed OutputStore", () => {
    const ctx = newContext()
    expect(ctx.config.clusterPath).toBe("/cluster")
    expect(ctx.outputs).toBeInstanceOf(OutputStore)
  })

  it("lazily builds + caches each chain client", () => {
    const ctx = newContext()
    const wire = ctx.wire
    expect(wire).toBeDefined()
    expect(ctx.wire).toBe(wire) // cached, not rebuilt
    expect(ctx.ethereum).toBe(ctx.ethereum)
    expect(ctx.solana).toBe(ctx.solana)
  })

  it("is a typed event emitter", () => {
    const ctx = newContext()
    let received: string | null = null
    ctx.on("greet", (message: string) => {
      received = message
    })
    ctx.emit("greet", "hi")
    expect(received).toBe("hi")
  })

  describe("nodeopUrl dialing (Phase 0 dial refactor)", () => {
    // producers[0].http in the fixture = DefaultBiosHttp + 100 (see pair(0)).
    const producerHttp = BindConfigProvider.DefaultBiosHttp + 100

    function withNodeopAddress(address: string) {
      return fixtureConfig({
        bind: {
          ...PersistedFixture.bind,
          nodeop: { ...PersistedFixture.bind.nodeop, address }
        }
      })
    }

    it("dials a remote bind address verbatim", () => {
      expect(ClusterBuildContext.nodeopUrl(withNodeopAddress("10.0.0.7"))).toBe(
        `http://10.0.0.7:${producerHttp}`
      )
    })

    it("maps a 0.0.0.0 (bind-all) address to loopback", () => {
      expect(ClusterBuildContext.nodeopUrl(withNodeopAddress("0.0.0.0"))).toBe(
        `http://127.0.0.1:${producerHttp}`
      )
    })
  })
})
