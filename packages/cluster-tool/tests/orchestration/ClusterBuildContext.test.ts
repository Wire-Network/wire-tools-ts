import {
  ClusterBuildContext,
  OutputStore
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

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
})
