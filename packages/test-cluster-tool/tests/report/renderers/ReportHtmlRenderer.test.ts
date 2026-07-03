import { ReportHtmlRenderer } from "@wireio/test-cluster-tool/report"
import {
  createBigintFailureReport,
  createFailureReport,
  createNestedReport,
  createSkippedTailReport,
  createSuccessReport
} from "../reportFixture.js"

describe("ReportHtmlRenderer", () => {
  it("renders a self-contained success document with foldable steps", () => {
    const html = new ReportHtmlRenderer(createSuccessReport()).render()
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain('<header class="ok">')
    expect(html).toContain("Run Succeeded")
    expect(html).toContain('<span class="actor">Sysio</span>')
    expect(html).toContain('<details class="phase ok"')
    expect(html).toContain('<details class="step ok"')
  })

  it("renders the failed step open with an error payload + escapes HTML", () => {
    const html = new ReportHtmlRenderer(createFailureReport()).render()
    expect(html).toContain('<header class="fail">')
    expect(html).toContain('<details class="step fail" open>')
    expect(html).toContain('<details class="payload error" open>')
    expect(html).toContain('<details class="step skip"')
    expect(html).not.toContain("<script src")
  })

  it("renders a failed step whose input nests bigints + byte arrays (no throw)", () => {
    const html = new ReportHtmlRenderer(createBigintFailureReport()).render()
    expect(html).toContain('<details class="payload error" open>')
    expect(html).toContain("2000000") // the bigint survives as its decimal string
    expect(html).toContain("insufficient bond")
  })

  it("a skipped tail fails the phase (all steps must be ok) + annotates the count", () => {
    const html = new ReportHtmlRenderer(createSkippedTailReport()).render()
    expect(html).toContain("[FAIL]</span> PhaseA")
    expect(html).toContain("2 skipped</small>")
  })

  it("nests groups to any depth as foldable details + ships the fold script", () => {
    const html = new ReportHtmlRenderer(createNestedReport()).render()
    // Bootstrap group wraps the Processes sub-group which wraps the Kiod phase.
    const bootstrapAt = html.indexOf("Bootstrap"),
      processesAt = html.indexOf("Processes"),
      kiodAt = html.indexOf("Kiod")
    expect(bootstrapAt).toBeGreaterThan(-1)
    expect(processesAt).toBeGreaterThan(bootstrapAt)
    expect(kiodAt).toBeGreaterThan(processesAt)
    expect(html).toContain('<details class="group ok"')
    expect(html).toContain('<details class="group fail" open>')
    expect(html).toContain('data-fold="expand"')
    expect(html).toContain("<script>")
  })

  it("collapses extra by default, expands it on the failed step", () => {
    const html = new ReportHtmlRenderer(createNestedReport()).render()
    // ok step: extra present but NOT open
    expect(html).toContain('<details class="payload extra"><summary>client calls (1)</summary>')
    // failed step: extra open
    expect(html).toContain('<details class="payload extra" open><summary>client calls (1)</summary>')
    expect(html).toContain("eth_sendRawTransaction")
  })
})
