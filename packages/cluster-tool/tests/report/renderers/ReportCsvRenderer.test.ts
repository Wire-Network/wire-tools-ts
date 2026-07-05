import { Report, ReportCsvRenderer } from "@wireio/cluster-tool/report"
import { createFailureReport, createNestedReport } from "../reportFixture.js"

describe("ReportCsvRenderer", () => {
  it("emits the header then one row per step (empty path for top-level phases)", () => {
    const csv = new ReportCsvRenderer(createFailureReport()).render()
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toBe(ReportCsvRenderer.Header)
    expect(lines).toHaveLength(4) // header + ok + failed + skipped
    expect(lines[1]).toContain(",Deploy,deploy-opreg,Sysio,ok,")
    expect(lines[2]).toContain("relay,BatchOperator,failed,")
  })

  it("renders nesting as the /-joined group path + extra as JSON", () => {
    const csv = new ReportCsvRenderer(createNestedReport()).render()
    const lines = csv.trimEnd().split("\n")
    expect(lines[1]).toContain("Bootstrap / Processes,Kiod,start-kiod,")
    expect(lines[2]).toContain("Bootstrap,Registry,regchain,")
    // extra rides the last column as (CSV-escaped) JSON
    expect(csv).toContain("wallet")
    expect(csv).toContain("eth_sendRawTransaction")
  })

  it("quotes + escapes a field containing a comma or quote", () => {
    const phase = new Report.PhaseBuilder("P", "d", Date.now())
      .push(
        Report.StepResult.failed(
          { name: "s", description: "d", actor: Report.Actor.User, input: null },
          1,
          new Error('a, "b"')
        )
      )
      .build()
    const csv = new ReportCsvRenderer(new Report().push(phase)).render()
    expect(csv).toContain('"a, ""b"""')
  })
})
