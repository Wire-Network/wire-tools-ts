import { Report, ReportJsonRenderer } from "@wireio/cluster-tool/report"
import {
  createBigintFailureReport,
  createFailureReport,
  createNestedReport
} from "../reportFixture.js"

/** Parse a rendered document back, the way a programmatic consumer would. */
function renderAndParse(report: Report): ReportJsonRenderer.Document {
  return JSON.parse(
    new ReportJsonRenderer(report).render()
  ) as ReportJsonRenderer.Document
}

/** Every step in the parsed tree, depth-first — the walk a consumer writes. */
function allSteps(
  nodes: ReadonlyArray<Report.Node>
): ReadonlyArray<Report.StepResult> {
  return nodes.flatMap(node =>
    node.kind === Report.NodeKind.group
      ? allSteps(node.children)
      : [...node.steps]
  )
}

describe("ReportJsonRenderer", () => {
  it("emits the run verdict and name alongside the tree", () => {
    const document = renderAndParse(createFailureReport())
    expect(document.name).toBe(Report.DefaultName)
    expect(document.succeeded).toBe(false)
  })

  it("PRESERVES nesting as a tree — groups keep children, phases keep steps", () => {
    // Given/When: a report whose phases are nested two groups deep.
    const document = renderAndParse(createNestedReport())

    // Then: the shape survives as structure, not as a flattened path string
    // (which is all csv can carry) — this is the whole point of the format.
    const bootstrap = document.nodes[0] as Report.Group
    expect(bootstrap.kind).toBe(Report.NodeKind.group)
    expect(bootstrap.name).toBe("Bootstrap")

    const processes = bootstrap.children[0] as Report.Group
    expect(processes.name).toBe("Processes")
    const kiod = processes.children[0] as Report.Phase
    expect(kiod.kind).toBe(Report.NodeKind.phase)
    expect(kiod.steps[0].name).toBe("start-kiod")
  })

  it("keeps each step's typed input, extra and error", () => {
    const document = renderAndParse(createNestedReport()),
      bootstrap = document.nodes[0] as Report.Group,
      registry = bootstrap.children[1] as Report.Phase

    expect(registry.steps[0].input).toEqual({ chains: 3 })

    const kiod = (bootstrap.children[0] as Report.Group)
      .children[0] as Report.Phase
    expect(kiod.steps[0].extra?.calls).toBeDefined()
  })

  it("plainifies bigints and byte arrays instead of throwing", () => {
    // Given: a step whose input carries bigints and a Uint8Array — the shapes
    // that make a naive JSON.stringify throw "Do not know how to serialize".
    // When/Then: rendering succeeds and the values survive readably.
    const document = renderAndParse(createBigintFailureReport()),
      phase = document.nodes[0] as Report.Phase,
      input = phase.steps[0].input as Record<string, unknown>

    expect(String(input.bondAmountWei)).toContain("2000000")
    expect(input.recipientBytes).toBeDefined()
  })

  it("carries the failure detail a consumer would triage on", () => {
    // Given/When: a report whose failure sits in the SECOND top-level phase.
    const steps = allSteps(renderAndParse(createFailureReport()).nodes),
      failed = steps.find(step => step.status === Report.StepStatus.failed)

    // Then: a consumer walking the tree reaches the error without parsing prose.
    expect(failed?.name).toBe("relay")
    expect(failed?.error?.message).toBe("timed out waiting for balance")
    // And the skipped tail is distinguishable from the failure.
    expect(
      steps.filter(step => step.status === Report.StepStatus.skipped)
    ).toHaveLength(1)
  })

  it("declares the json format", () => {
    expect(new ReportJsonRenderer(createFailureReport()).format).toBe(
      Report.Format.json
    )
  })
})
