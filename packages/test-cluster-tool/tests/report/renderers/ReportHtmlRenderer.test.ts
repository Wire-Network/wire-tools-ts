import { ReportHtmlRenderer } from "@wireio/test-cluster-tool/report"
import {
  createBigintFailureReport,
  createFailureReport,
  createSkippedTailReport,
  createSuccessReport
} from "../reportFixture.js"

describe("ReportHtmlRenderer", () => {
  it("renders a self-contained success document", () => {
    const html = new ReportHtmlRenderer(createSuccessReport()).render()
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain('<header class="ok">')
    expect(html).toContain("Run Succeeded")
    expect(html).toContain('<span class="actor">Sysio</span>')
  })

  it("renders the failed step with an inline error block + escapes HTML", () => {
    const html = new ReportHtmlRenderer(createFailureReport()).render()
    expect(html).toContain('<header class="fail">')
    expect(html).toContain('<li class="fail">')
    expect(html).toContain('<pre class="err">')
    expect(html).toContain('<li class="skip">')
    // the JSON error block is HTML-escaped (quotes survive, angle brackets escaped)
    expect(html).not.toContain("<script")
  })

  it("renders a failed step whose input nests bigints + byte arrays (no throw)", () => {
    const html = new ReportHtmlRenderer(createBigintFailureReport()).render()
    expect(html).toContain('<pre class="err">')
    expect(html).toContain("2000000") // the bigint survives as its decimal string
    expect(html).toContain("insufficient bond")
  })

  it("a skipped tail fails the phase (all steps must be ok) + annotates the count", () => {
    const html = new ReportHtmlRenderer(createSkippedTailReport()).render()
    expect(html).toContain("[FAIL] PhaseA")
    expect(html).toContain("· 2 skipped</small>")
  })
})
