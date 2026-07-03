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

  it("collapses identical repeated calls into one counted entry (poll loops)", () => {
    const recorder = new StepExtraRecorder()
    const query = {
      client: "wire",
      kind: "rpc",
      path: "/v1/chain/get_table_rows",
      params: { code: "sysio.opreg", table: "operators" }
    }
    recorder.record(query)
    recorder.record(query)
    recorder.record(query)
    expect(recorder.calls.length).toBe(1)
    expect(recorder.calls[0].count).toBe(3)
  })

  it("collapses ALTERNATING poll patterns within the dedupe window", () => {
    const recorder = new StepExtraRecorder()
    const receipt = { client: "ethereum", kind: "call", method: "eth_getTransactionReceipt" }
    const blockNumber = { client: "ethereum", kind: "call", method: "eth_blockNumber" }
    ;[receipt, blockNumber, receipt, blockNumber, receipt].forEach(call =>
      recorder.record({ ...call })
    )
    expect(recorder.calls.length).toBe(2)
    expect(recorder.calls[0].count).toBe(3)
    expect(recorder.calls[1].count).toBe(2)
  })

  it("does NOT collapse calls whose payloads differ (distinct writes)", () => {
    const recorder = new StepExtraRecorder()
    recorder.record({ client: "clio", kind: "cli", command: ["a"], durationMs: 5 })
    recorder.record({ client: "clio", kind: "cli", command: ["a"], durationMs: 9 })
    expect(recorder.calls.length).toBe(2)
  })

  it("caps entries at MaxCalls and surfaces the overflow as dropped", () => {
    const recorder = new StepExtraRecorder()
    Array.from({ length: StepExtraRecorder.MaxCalls + 7 }, (_, index) =>
      recorder.record({ client: "wire", kind: "rpc", index })
    )
    expect(recorder.calls.length).toBe(StepExtraRecorder.MaxCalls)
    expect(recorder.toExtra()?.dropped).toBe(7)
  })

  it("note() lands a harness note entry with merged data", () => {
    const recorder = new StepExtraRecorder()
    StepExtraRecorder.runWith(recorder, async () => {
      StepExtraRecorder.note("check deposited collateral for some.acct", {
        account: "some.acct"
      })
    })
    expect(recorder.calls).toEqual([
      {
        client: "harness",
        kind: "note",
        text: "check deposited collateral for some.acct",
        account: "some.acct"
      }
    ])
  })

  it("every executed step gets extra — a no-call runner falls back to its description", async () => {
    const build = fixtureBuild()
    const phase = ClusterBuildPhase.create(build, "P", "fallback", []).push(
      ClusterBuildStep.create(
        Report.Actor.Sysio,
        "checkpoint",
        "confirm the registry rows landed",
        {},
        null,
        async () => undefined
      )
    )
    const nodes = await phase.run(new AbortController().signal)
    expect((nodes[0] as Report.Phase).steps[0].extra).toEqual({
      calls: [
        {
          client: "harness",
          kind: "note",
          text: "confirm the registry rows landed"
        }
      ]
    })
  })

  it("skipped steps carry a note explaining they never ran", async () => {
    const build = fixtureBuild()
    const phase = ClusterBuildPhase.create(build, "P", "skip tail", []).push(
      ClusterBuildStep.create(Report.Actor.Sysio, "boom", "fails", {}, null, async () => {
        throw new Error("boom")
      }),
      ClusterBuildStep.create(Report.Actor.Sysio, "tail", "never runs", {}, null, async () => undefined)
    )
    const nodes = await phase.run(new AbortController().signal)
    const tail = (nodes[0] as Report.Phase).steps[1]
    expect(tail.status).toBe(Report.StepStatus.skipped)
    expect(JSON.stringify(tail.extra)).toContain("never ran")
  })

  it("caps long strings with an elision annotation", () => {
    const recorder = new StepExtraRecorder()
    recorder.record({
      client: "ethereum",
      kind: "rpc",
      raw: "ab".repeat(StepExtraRecorder.MaxStringLength)
    })
    const raw = recorder.calls[0].raw as string
    expect(raw.length).toBeLessThan(StepExtraRecorder.MaxStringLength + 30)
    expect(raw).toContain("…(+")
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
