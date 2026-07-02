import { match } from "ts-pattern"
import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/** A single self-contained HTML file (inline CSS) — an actor-by-actor timeline. */
export class ReportHtmlRenderer implements ReportRenderer {
  readonly format = Report.Format.html

  constructor(private readonly report: Report) {}

  render(): string {
    const report = this.report,
      totalMs = report.phases.reduce((sum, phase) => sum + phase.durationMs, 0),
      stepCount = report.phases.reduce((count, phase) => count + phase.steps.length, 0),
      phases = report.phases.map(phase => this.renderPhase(phase)).join("\n")
    return [
      "<!doctype html>",
      `<html lang="en"><head><meta charset="utf-8">`,
      `<title>Cluster Run Report — ${report.succeeded ? "SUCCEEDED" : "FAILED"}</title>`,
      `<style>${ReportHtmlRenderer.Css}</style></head>`,
      `<body><header class="${report.succeeded ? "ok" : "fail"}">`,
      `<h1>${report.succeeded ? "Run Succeeded" : "Run Failed"}</h1>`,
      `<p>${report.phases.length} phases · ${stepCount} steps · ` +
        `${(totalMs / 1000).toFixed(1)}s</p></header>`,
      `<main>${phases}</main></body></html>`
    ].join("\n")
  }

  private renderPhase(phase: Report.Phase): string {
    const steps = phase.steps.map(step => this.renderStep(step)).join("\n"),
      skippedCount = Report.Phase.skippedCount(phase)
    return (
      `<section class="phase ${phase.succeeded ? "ok" : "fail"}">` +
      `<h2>${phase.succeeded ? "[OK]" : "[FAIL]"} ${ReportHtmlRenderer.esc(phase.name)} ` +
      `<small>${ReportHtmlRenderer.esc(phase.description)} · ` +
      `${(phase.durationMs / 1000).toFixed(1)}s` +
      `${skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}</small></h2>` +
      `<ol class="timeline">${steps}</ol></section>`
    )
  }

  private renderStep(step: Report.StepResult): string {
    const cls = match(step.status)
        .with(Report.StepStatus.ok, () => "ok")
        .with(Report.StepStatus.failed, () => "fail")
        .with(Report.StepStatus.skipped, () => "skip")
        .exhaustive(),
      // plainify first: step inputs routinely nest bigints / Uint8Arrays,
      // which JSON.stringify rejects — on the FAILURE path this must render.
      error =
        step.error === null
          ? ""
          : `<pre class="err">${ReportHtmlRenderer.esc(JSON.stringify(plainify(step.error), null, 2))}</pre>`
    return (
      `<li class="${cls}"><span class="actor">${step.actor}</span>` +
      `<span class="name">${ReportHtmlRenderer.esc(step.name)}</span>` +
      `<span class="dur">${step.durationMs}ms</span>${error}</li>`
    )
  }

  private static esc(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }
}

export namespace ReportHtmlRenderer {
  /** Inline stylesheet for the self-contained report (dark, monospace timeline). */
  export const Css = `
    :root{font-family:ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9}
    body{margin:0;padding:1.5rem;max-width:1000px;margin:auto}
    header h1{margin:.2rem 0}
    header.ok h1{color:#3fb950} header.fail h1{color:#f85149}
    section.phase{border:1px solid #30363d;border-radius:8px;margin:1rem 0;padding:.5rem 1rem}
    section.phase.fail{border-color:#f85149}
    h2 small{font-weight:400;color:#8b949e}
    ol.timeline{list-style:none;padding-left:0;margin:.5rem 0}
    ol.timeline li{display:grid;grid-template-columns:9rem 1fr 5rem;gap:.5rem;
      align-items:center;padding:.25rem .5rem;border-left:3px solid #30363d}
    li.ok{border-left-color:#3fb950} li.fail{border-left-color:#f85149}
    li.skip{border-left-color:#6e7681;color:#6e7681}
    .actor{background:#161b22;border-radius:4px;padding:.1rem .4rem;text-align:center;font-size:.85em}
    .dur{color:#8b949e;text-align:right}
    pre.err{grid-column:1/-1;background:#161b22;border:1px solid #f85149;border-radius:6px;
      padding:.5rem;white-space:pre-wrap;color:#ffa198;font-size:.85em}`
}
