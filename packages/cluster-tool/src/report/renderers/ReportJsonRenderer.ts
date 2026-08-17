import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/**
 * The narrative tree verbatim, as JSON — the machine-readable format.
 *
 * `csv` flattens the tree to one row per step (nesting survives only as a
 * `path` string) and `md`/`html` are for humans, so any programmatic consumer
 * — a CI summarizer, a regression comparison across two runs, a script asking
 * "which step failed and how long did each rung take" — had to parse rendered
 * markdown. This renderer emits {@link Report.Node} as-is: groups keep their
 * `children`, phases keep their `steps`, and every step keeps its typed
 * `input`, `extra`, and `error`.
 *
 * Values are `plainify`d (bigints, byte arrays, class instances become
 * JSON-safe) exactly as the csv renderer does, so a step's recorded
 * `TokenAmount` inputs survive the round-trip instead of throwing.
 */
export class ReportJsonRenderer implements ReportRenderer {
  readonly format = Report.Format.json

  constructor(private readonly report: Report) {}

  render(): string {
    const document: ReportJsonRenderer.Document = {
      name: this.report.name ?? Report.DefaultName,
      succeeded: this.report.succeeded,
      nodes: this.report.nodes
    }
    return `${JSON.stringify(plainify(document), null, ReportJsonRenderer.Indent)}\n`
  }
}

export namespace ReportJsonRenderer {
  /** The emitted document — the run's verdict plus its narrative tree. */
  export interface Document {
    name: string
    succeeded: boolean
    nodes: ReadonlyArray<Report.Node>
  }

  /** Indentation width; the file is read by humans when a run is diagnosed. */
  export const Indent = 2
}
