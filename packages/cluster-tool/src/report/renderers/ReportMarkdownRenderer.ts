import { match } from "ts-pattern"
import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/**
 * The narrative tree as nested markdown: one heading per group / phase (depth
 * = nesting level), a step table per phase, then a collapsible JSON
 * `<details>` block per failed step (error) and per step with recorded client
 * calls (`extra`).
 */
export class ReportMarkdownRenderer implements ReportRenderer {
  readonly format = Report.Format.md

  constructor(private readonly report: Report) {}

  render(): string {
    const report = this.report,
      phases = report.phases,
      totalMs = report.nodes.reduce((sum, node) => sum + node.durationMs, 0),
      stepCount = phases.reduce((count, phase) => count + phase.steps.length, 0),
      out: string[] = [
        `# ${Report.title(report)}`,
        "",
        `${Report.timestampLine()} · **Phases:** ${phases.length} · **Steps:** ${stepCount} · ` +
          `**Duration:** ${(totalMs / 1000).toFixed(1)}s`,
        ""
      ]
    report.nodes.forEach(node => this.renderNode(node, 0, out))
    return out.join("\n")
  }

  /** Depth-first: a group renders its heading then recurses; a phase renders
   *  its heading, step table, and detail blocks. Heading depth caps at h6. */
  private renderNode(node: Report.Node, depth: number, out: string[]): void {
    const heading = "#".repeat(Math.min(depth + 2, 6)),
      verdict = node.succeeded ? "[OK]" : "[FAIL]",
      skippedCount = Report.Node.skippedCount(node),
      skippedSuffix = skippedCount > 0 ? ` · ${skippedCount} skipped` : ""
    if (Report.Node.isGroup(node)) {
      out.push(
        `${heading} ${verdict} ${node.name} — _${node.description}_ ` +
          `(${(node.durationMs / 1000).toFixed(1)}s · ` +
          `${Report.Node.stepCount(node)} steps${skippedSuffix})`,
        ""
      )
      node.children.forEach(child => this.renderNode(child, depth + 1, out))
      return
    }
    out.push(
      `${heading} ${verdict} ${node.name} — _${node.description}_ ` +
        `(${(node.durationMs / 1000).toFixed(1)}s${skippedSuffix})`,
      "",
      "| # | Step | Actor | Status | Duration |",
      "|---|------|-------|--------|----------|"
    )
    node.steps.forEach((step, index) =>
      out.push(
        `| ${index + 1} | ${step.name} | ${step.actor} | ` +
          `${ReportMarkdownRenderer.badge(step.status)} | ${step.durationMs}ms |`
      )
    )
    out.push("")
    node.steps.forEach(step => {
      if (step.error !== null) {
        this.renderDetails(
          `[FAIL] <code>${step.name}</code> — error detail`,
          step.error,
          out
        )
      }
      if (step.extra !== null) {
        this.renderDetails(
          `<code>${step.name}</code> — extra (${ReportMarkdownRenderer.callCount(step)})`,
          step.extra,
          out
        )
      }
    })
  }

  /** One collapsible JSON block. */
  private renderDetails(summary: string, payload: unknown, out: string[]): void {
    out.push(
      `<details><summary>${summary}</summary>`,
      "",
      "```json",
      // plainify first: step inputs routinely nest bigints / Uint8Arrays,
      // which JSON.stringify rejects — on the FAILURE path this must render.
      JSON.stringify(plainify(payload), null, 2),
      "```",
      "</details>",
      ""
    )
  }

  private static badge(status: Report.StepStatus): string {
    return match(status)
      .with(Report.StepStatus.ok, () => "ok")
      .with(Report.StepStatus.failed, () => "failed")
      .with(Report.StepStatus.skipped, () => "skipped")
      .exhaustive()
  }
}

export namespace ReportMarkdownRenderer {
  /** Count of recorded extra entries (client calls + notes) on a step. */
  export function callCount(step: Report.StepResult): number {
    const calls = step.extra?.calls
    return Array.isArray(calls) ? calls.length : 0
  }
}
