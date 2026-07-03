import { Report, StepExtraRecorder } from "@wireio/test-cluster-tool/report"
import { getLogger } from "@wireio/shared"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildStep
} from "@wireio/test-cluster-tool/orchestration"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

function fixtureBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("extra-test"))
  )
}

describe("StepExtraRecorder", () => {
  it("plainifies entries at capture so extra stringifies without modification", () => {
    const recorder = new StepExtraRecorder()
    recorder.record({
      client: "clio",
      kind: "cli",
      amount: 15_000_000_000n,
      bytes: Uint8Array.of(1, 2, 3)
    })
    const extra = recorder.toExtra()
    expect(extra).not.toBeNull()
    expect(() => JSON.stringify(extra)).not.toThrow()
    expect(JSON.stringify(extra)).toContain("15000000000")
  })

  it("toExtra is null when nothing was recorded", () => {
    expect(new StepExtraRecorder().toExtra()).toBeNull()
  })

  it("record() outside any step scope is a silent no-op", () => {
    expect(StepExtraRecorder.current()).toBeNull()
    expect(() =>
      StepExtraRecorder.record({ client: "clio", kind: "cli" })
    ).not.toThrow()
  })

  it("scopes captures to the recording step, including PARALLEL steps", async () => {
    const build = fixtureBuild()
    const phase = ClusterBuildPhase.create(build, "P", "parallel capture", [], {
      parallelize: true
    }).push(
      ClusterBuildStep.create(Report.Actor.Sysio, "a", "a", {}, null, async () => {
        StepExtraRecorder.record({ client: "clio", kind: "cli", step: "a" })
      }),
      ClusterBuildStep.create(Report.Actor.Sysio, "b", "b", {}, null, async () => {
        StepExtraRecorder.record({ client: "solana", kind: "transaction", step: "b" })
        StepExtraRecorder.record({ client: "solana", kind: "airdrop", step: "b" })
      })
    )
    const nodes = await phase.run(new AbortController().signal)
    const steps = (nodes[0] as Report.Phase).steps
    expect(steps[0].extra).toEqual({
      calls: [{ client: "clio", kind: "cli", step: "a" }]
    })
    expect((steps[1].extra?.calls as unknown[]).length).toBe(2)
  })

  it("a failed step still carries its recorded calls", async () => {
    const build = fixtureBuild()
    const phase = ClusterBuildPhase.create(build, "P", "failure capture").push(
      ClusterBuildStep.create(Report.Actor.User, "boom", "boom", {}, null, async () => {
        StepExtraRecorder.record({ client: "ethereum", kind: "rpc", method: "eth_sendRawTransaction" })
        throw new Error("boom")
      })
    )
    const nodes = await phase.run(new AbortController().signal)
    const step = (nodes[0] as Report.Phase).steps[0]
    expect(step.status).toBe(Report.StepStatus.failed)
    expect((step.extra?.calls as Array<{ method?: string }>)[0].method).toBe(
      "eth_sendRawTransaction"
    )
  })
})
