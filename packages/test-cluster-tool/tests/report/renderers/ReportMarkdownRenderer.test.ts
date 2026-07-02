import { ReportMarkdownRenderer } from "@wireio/test-cluster-tool/report"
import {
  createBigintFailureReport,
  createFailureReport,
  createSkippedTailReport,
  createSuccessReport
} from "../reportFixture.js"

describe("ReportMarkdownRenderer", () => {
  it("titles a successful run + renders a phase table", () => {
    const md = new ReportMarkdownRenderer(createSuccessReport()).render()
    expect(md).toContain("# Cluster Run Report — SUCCEEDED")
    expect(md).toContain("## [OK] Deploy")
    expect(md).toContain("| # | Step | Actor | Status | Duration |")
    expect(md).toContain("| 1 | deploy-opreg | Sysio | ok | 120ms |")
  })

  it("marks a failed run + embeds a collapsible error-detail block", () => {
    const md = new ReportMarkdownRenderer(createFailureReport()).render()
    expect(md).toContain("# Cluster Run Report — FAILED")
    expect(md).toContain("## [FAIL] DepositSOL")
    expect(md).toContain("<details><summary>[FAIL] <code>relay</code>")
    expect(md).toContain("timed out waiting for balance")
  })

  it("renders a failed step whose input nests bigints + byte arrays (no throw)", () => {
    const md = new ReportMarkdownRenderer(createBigintFailureReport()).render()
    expect(md).toContain("insufficient bond")
    expect(md).toContain("2000000") // the bigint survives as its decimal string
  })

  it("a skipped tail fails the phase (all steps must be ok) + annotates the count", () => {
    const md = new ReportMarkdownRenderer(createSkippedTailReport()).render()
    expect(md).toContain("# Cluster Run Report — FAILED")
    expect(md).toContain("## [FAIL] PhaseA")
    expect(md).toContain("· 2 skipped)")
  })

  it("annotates the skipped count on a failed phase's header", () => {
    const md = new ReportMarkdownRenderer(createFailureReport()).render()
    expect(md).toContain("· 1 skipped)")
  })
})
