import { match } from "ts-pattern"
import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/** Title + per-phase tables + a collapsible JSON block per failed step. */
export class ReportMarkdownRenderer implements ReportRenderer {
  readonly format = Report.Format.md

  constructor(private readonly report: Report) {}

  render(): string {
    const report = this.report,
      totalMs = report.phases.reduce((sum, phase) => sum + phase.durationMs, 0),
      stepCount = report.phases.reduce((count, phase) => count + phase.steps.length, 0),
      out: string[] = [
        `# Cluster Run Report — ${report.succeeded ? "SUCCEEDED" : "FAILED"}`,
        "",
        `**Phases:** ${report.phases.length} · **Steps:** ${stepCount} · ` +
          `**Duration:** ${(totalMs / 1000).toFixed(1)}s`,
        ""
      ]
    report.phases.forEach(phase => {
      const skippedCount = Report.Phase.skippedCount(phase)
      out.push(
        `## ${phase.succeeded ? "[OK]" : "[FAIL]"} ${phase.name} — _${phase.description}_ ` +
          `(${(phase.durationMs / 1000).toFixed(1)}s` +
          `${skippedCount > 0 ? ` · ${skippedCount} skipped` : ""})`,
        "",
        "| # | Step | Actor | Status | Duration |",
        "|---|------|-------|--------|----------|"
      )
      phase.steps.forEach((step, index) =>
        out.push(
          `| ${index + 1} | ${step.name} | ${step.actor} | ` +
            `${ReportMarkdownRenderer.badge(step.status)} | ${step.durationMs}ms |`
        )
      )
      out.push("")
      phase.steps
        .filter(step => step.error !== null)
        .forEach(step =>
          out.push(
            `<details><summary>[FAIL] <code>${step.name}</code> — error detail</summary>`,
            "",
            "```json",
            // plainify first: step inputs routinely nest bigints / Uint8Arrays,
            // which JSON.stringify rejects — on the FAILURE path this must render.
            JSON.stringify(plainify(step.error), null, 2),
            "```",
            "</details>",
            ""
          )
        )
    })
    return out.join("\n")
  }

  private static badge(status: Report.StepStatus): string {
    return match(status)
      .with(Report.StepStatus.ok, () => "ok")
      .with(Report.StepStatus.failed, () => "failed")
      .with(Report.StepStatus.skipped, () => "skipped")
      .exhaustive()
  }
}
