import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/**
 * One row per step. Nesting rides the `path` column — the `/`-joined chain of
 * enclosing group names (empty for a top-level phase); `phase` is the step's
 * immediate phase. `extra` is the step's recorded client-call object as JSON
 * (empty when none).
 */
export class ReportCsvRenderer implements ReportRenderer {
  readonly format = Report.Format.csv

  constructor(private readonly report: Report) {}

  render(): string {
    const rows: string[] = [ReportCsvRenderer.Header]
    this.report.nodes.forEach(node => this.renderNode(node, [], rows))
    return rows.join("\n") + "\n"
  }

  /** Depth-first walk: groups extend `path`, phases emit their step rows. */
  private renderNode(node: Report.Node, path: string[], rows: string[]): void {
    if (Report.Node.isGroup(node)) {
      node.children.forEach(child =>
        this.renderNode(child, [...path, node.name], rows)
      )
      return
    }
    node.steps.forEach(step =>
      rows.push(
        [
          path.join(ReportCsvRenderer.PathSeparator),
          node.name,
          step.name,
          step.actor,
          step.status,
          step.startedAt,
          String(step.durationMs),
          step.error ? step.error.message : "",
          step.extra ? JSON.stringify(plainify(step.extra)) : ""
        ]
          .map(ReportCsvRenderer.escape)
          .join(",")
      )
    )
  }

  private static escape(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  }
}

export namespace ReportCsvRenderer {
  export const Header =
    "path,phase,step,actor,status,startedAt,durationMs,error,extra"
  /** Joins the enclosing group names in the `path` column. */
  export const PathSeparator = " / "
}
