import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/** One row per step: `phase,step,actor,status,startedAt,durationMs,error`. */
export class ReportCsvRenderer implements ReportRenderer {
  readonly format = Report.Format.csv

  constructor(private readonly report: Report) {}

  render(): string {
    const rows: string[] = [ReportCsvRenderer.Header]
    this.report.phases.forEach(phase =>
      phase.steps.forEach(step =>
        rows.push(
          [
            phase.name,
            step.name,
            step.actor,
            step.status,
            step.startedAt,
            String(step.durationMs),
            step.error ? step.error.message : ""
          ]
            .map(ReportCsvRenderer.escape)
            .join(",")
        )
      )
    )
    return rows.join("\n") + "\n"
  }

  private static escape(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  }
}

export namespace ReportCsvRenderer {
  export const Header = "phase,step,actor,status,startedAt,durationMs,error"
}
