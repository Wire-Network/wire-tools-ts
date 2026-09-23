import { ReadinessClient } from "@wireio/cluster-tool/clients/readiness"
import { createReadinessConfig } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ConnectedReadinessContext,
  ReadinessAssertionError,
  type ReadinessCapable,
  runReadinessAssertion
} from "@wireio/cluster-tool/orchestration/contexts"

const config = createReadinessConfig({
  wireRpc: "https://wire.example",
  ethereumRpc: "https://ethereum.example",
  solanaRpc: "https://solana.example",
  report: { path: "/tmp", basename: "readiness", formats: [] }
})

describe("ConnectedReadinessContext", () => {
  it("creates a readiness client around validated explicit endpoints", () => {
    const context = new ConnectedReadinessContext(
      config,
      getLogger("connected-readiness-context-test")
    )
    expect(context.config).toBe(config)
    expect(context.readiness).toBeInstanceOf(ReadinessClient)
  })
})

describe("runReadinessAssertion", () => {
  it("records successful structured evidence", async () => {
    const recordEvidence = jest.fn(),
      context = { readiness: { recordEvidence } } as unknown as ReadinessCapable
    await runReadinessAssertion(context, async () => ({
      detail: "ready",
      evidence: { value: 7 }
    }))
    expect(recordEvidence).toHaveBeenCalledWith("ready", { value: 7 })
  })

  it("records failure evidence and preserves the assertion error", async () => {
    const recordEvidence = jest.fn(),
      context = {
        readiness: { recordEvidence }
      } as unknown as ReadinessCapable,
      error = new ReadinessAssertionError("not ready", { reason: "fixture" })
    await expect(
      runReadinessAssertion(context, async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(recordEvidence).toHaveBeenCalledWith("not ready", {
      reason: "fixture"
    })
  })
})
