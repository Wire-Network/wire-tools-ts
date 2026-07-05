import { ReportMarkdownRenderer } from "@wireio/cluster-tool/report"
import {
  createBigintFailureReport,
  createFailureReport,
  createNestedReport,
  createSkippedTailReport,
  createSuccessReport
} from "../reportFixture.js"

describe("ReportMarkdownRenderer", () => {
  it("titles a successful run + renders a phase table", () => {
    const md = new ReportMarkdownRenderer(createSuccessReport()).render()
    expect(md).toContain("# cluster-build: SUCCESS")
    expect(md).toContain("## [OK] Deploy")
    expect(md).toContain("| # | Step | Actor | Status | Duration |")
    expect(md).toContain("| 1 | deploy-opreg | Sysio | ok | 120ms |")
  })

  it("marks a failed run + embeds a collapsible error-detail block", () => {
    const md = new ReportMarkdownRenderer(createFailureReport()).render()
    expect(md).toContain("# cluster-build: FAILED")
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
    expect(md).toContain("# cluster-build: FAILED")
    expect(md).toContain("## [FAIL] PhaseA")
    expect(md).toContain("· 2 skipped)")
  })

  it("annotates the skipped count on a failed phase's header", () => {
    const md = new ReportMarkdownRenderer(createFailureReport()).render()
    expect(md).toContain("· 1 skipped)")
  })
})

describe("ReportMarkdownRenderer nesting + extra", () => {
  it("deepens heading level per nesting depth", () => {
    const md = new ReportMarkdownRenderer(createNestedReport()).render()
    expect(md).toContain("## [OK] Bootstrap")
    expect(md).toContain("### [OK] Processes")
    expect(md).toContain("#### [OK] Kiod")
    expect(md).toContain("### [OK] Registry")
    expect(md).toContain("## [FAIL] Scenario")
  })

  it("renders a client-calls details block per step with extra", () => {
    const md = new ReportMarkdownRenderer(createNestedReport()).render()
    expect(md).toContain("<code>start-kiod</code> — extra (1)")
    expect(md).toContain("eth_sendRawTransaction")
  })
})
