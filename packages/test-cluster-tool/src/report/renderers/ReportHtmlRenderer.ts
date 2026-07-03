import { match } from "ts-pattern"
import { plainify } from "@wireio/debugging-shared"
import { Report } from "../Report.js"
import type { ReportRenderer } from "../ReportRenderer.js"

/**
 * A single self-contained HTML file (inline CSS + JS) rendering the narrative
 * TREE — nested, foldable `<details>` sections for every phase group, phase,
 * and step, to any depth. Folding defaults: the failure path (every ancestor
 * of a failed/skipped step, the step itself, and its `extra`) renders OPEN;
 * everything else renders collapsed, with top-level nodes open for
 * orientation. The inline JS adds expand-all / collapse-all / failures-only
 * controls over the same `<details>` folding.
 */
export class ReportHtmlRenderer implements ReportRenderer {
  readonly format = Report.Format.html

  constructor(private readonly report: Report) {}

  render(): string {
    const report = this.report,
      totalMs = report.nodes.reduce((sum, node) => sum + node.durationMs, 0),
      stepCount = report.phases.reduce(
        (count, phase) => count + phase.steps.length,
        0
      ),
      nodes = report.nodes
        .map(node => this.renderNode(node, 0))
        .join("\n")
    return [
      "<!doctype html>",
      `<html lang="en"><head><meta charset="utf-8">`,
      `<title>Cluster Run Report — ${report.succeeded ? "SUCCEEDED" : "FAILED"}</title>`,
      `<style>${ReportHtmlRenderer.Css}</style></head>`,
      `<body><header class="${report.succeeded ? "ok" : "fail"}">`,
      `<h1>${report.succeeded ? "Run Succeeded" : "Run Failed"}</h1>`,
      `<p>${report.phases.length} phases · ${stepCount} steps · ` +
        `${(totalMs / 1000).toFixed(1)}s</p>`,
      `<nav class="fold-controls">` +
        `<button data-fold="expand">Expand all</button>` +
        `<button data-fold="collapse">Collapse all</button>` +
        `<button data-fold="failures">Failures only</button></nav>`,
      `</header>`,
      `<main>${nodes}</main>`,
      `<script>${ReportHtmlRenderer.FoldScript}</script>`,
      `</body></html>`
    ].join("\n")
  }

  /** One tree node: a group `<details>` recursing into children, or a phase. */
  private renderNode(node: Report.Node, depth: number): string {
    const open = ReportHtmlRenderer.openByDefault(node, depth),
      verdict = node.succeeded ? "[OK]" : "[FAIL]",
      cls = node.succeeded ? "ok" : "fail",
      skippedCount = Report.Node.skippedCount(node),
      skippedSuffix = skippedCount > 0 ? ` · ${skippedCount} skipped` : ""
    if (Report.Node.isGroup(node)) {
      const children = node.children
        .map(child => this.renderNode(child, depth + 1))
        .join("\n")
      return (
        `<details class="group ${cls}"${open ? " open" : ""}>` +
        `<summary><span class="verdict">${verdict}</span> ` +
        `${ReportHtmlRenderer.esc(node.name)} ` +
        `<small>${ReportHtmlRenderer.esc(node.description)} · ` +
        `${(node.durationMs / 1000).toFixed(1)}s · ` +
        `${Report.Node.stepCount(node)} steps${skippedSuffix}</small></summary>` +
        `<div class="children">${children}</div></details>`
      )
    }
    const steps = node.steps.map(step => this.renderStep(step)).join("\n")
    return (
      `<details class="phase ${cls}"${open ? " open" : ""}>` +
      `<summary><span class="verdict">${verdict}</span> ` +
      `${ReportHtmlRenderer.esc(node.name)} ` +
      `<small>${ReportHtmlRenderer.esc(node.description)} · ` +
      `${(node.durationMs / 1000).toFixed(1)}s${skippedSuffix}</small></summary>` +
      `<div class="steps">${steps}</div></details>`
    )
  }

  /** One foldable step: summary row + input / client calls / error payloads. */
  private renderStep(step: Report.StepResult): string {
    const cls = match(step.status)
        .with(Report.StepStatus.ok, () => "ok")
        .with(Report.StepStatus.failed, () => "fail")
        .with(Report.StepStatus.skipped, () => "skip")
        .exhaustive(),
      failed = step.status === Report.StepStatus.failed,
      body: string[] = []
    if (step.input !== null) {
      body.push(this.renderPayload("input", step.input, false))
    }
    if (step.extra !== null) {
      // Recorded client calls: collapsed by default, EXPANDED when the
      // owning step failed (the calls are the failure's forensic trail).
      body.push(
        this.renderPayload(
          `client calls (${ReportHtmlRenderer.callCount(step)})`,
          step.extra,
          failed,
          "extra"
        )
      )
    }
    if (step.error !== null) {
      body.push(this.renderPayload("error", step.error, true, "error"))
    }
    return (
      `<details class="step ${cls}"${failed ? " open" : ""}>` +
      `<summary><span class="actor">${step.actor}</span>` +
      `<span class="name">${ReportHtmlRenderer.esc(step.name)} ` +
      `<small>${ReportHtmlRenderer.esc(step.description)}</small></span>` +
      `<span class="status ${cls}">${step.status}</span>` +
      `<span class="dur">${step.durationMs.toFixed(0)}ms</span></summary>` +
      `<div class="payloads">${body.join("\n")}</div></details>`
    )
  }

  /** One collapsible JSON payload block under a step. */
  private renderPayload(
    label: string,
    payload: unknown,
    open: boolean,
    kind: string = "input"
  ): string {
    // plainify first: step inputs routinely nest bigints / Uint8Arrays,
    // which JSON.stringify rejects — on the FAILURE path this must render.
    const json = JSON.stringify(plainify(payload), null, 2)
    return (
      `<details class="payload ${kind}"${open ? " open" : ""}>` +
      `<summary>${ReportHtmlRenderer.esc(label)}</summary>` +
      `<pre>${ReportHtmlRenderer.esc(json)}</pre></details>`
    )
  }

  private static esc(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }
}

export namespace ReportHtmlRenderer {
  /** Count of recorded client calls on a step (0 when `extra` is absent). */
  export function callCount(step: Report.StepResult): number {
    const calls = step.extra?.calls
    return Array.isArray(calls) ? calls.length : 0
  }

  /**
   * Default fold state for a tree node: open when it (or any descendant)
   * failed or skipped — the failure path unfolds itself — and open at the
   * top level for orientation; collapsed otherwise.
   */
  export function openByDefault(node: Report.Node, depth: number): boolean {
    return Report.Node.hasProblem(node) || depth === 0
  }

  /** Inline stylesheet for the self-contained report (dark, monospace tree). */
  export const Css = `
    :root{font-family:ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9}
    body{margin:0;padding:1.5rem;max-width:1100px;margin:auto}
    header h1{margin:.2rem 0}
    header.ok h1{color:#3fb950} header.fail h1{color:#f85149}
    nav.fold-controls{margin:.6rem 0}
    nav.fold-controls button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;
      border-radius:6px;padding:.3rem .7rem;margin-right:.5rem;font:inherit;cursor:pointer}
    nav.fold-controls button:hover{background:#30363d}
    details{border:1px solid #30363d;border-radius:8px;margin:.5rem 0}
    details.fail{border-color:#f8514966}
    details>summary{cursor:pointer;padding:.4rem .8rem;user-select:none}
    details>summary:hover{background:#161b22}
    details.group>summary{font-weight:600}
    .verdict{font-weight:600}
    details.ok>summary .verdict{color:#3fb950}
    details.fail>summary .verdict{color:#f85149}
    summary small{font-weight:400;color:#8b949e}
    .children,.steps,.payloads{padding:.2rem .8rem .6rem .8rem}
    details.step>summary{display:grid;grid-template-columns:10rem 1fr 5rem 5.5rem;
      gap:.5rem;align-items:center}
    details.step{border-left-width:3px}
    details.step.ok{border-left-color:#3fb950}
    details.step.fail{border-left-color:#f85149}
    details.step.skip{border-left-color:#6e7681;color:#6e7681}
    .actor{background:#161b22;border-radius:4px;padding:.1rem .4rem;text-align:center;font-size:.85em}
    .status{text-align:center;font-size:.85em}
    .status.ok{color:#3fb950} .status.fail{color:#f85149} .status.skip{color:#6e7681}
    .dur{color:#8b949e;text-align:right}
    details.payload{border-style:dashed}
    details.payload.error{border-color:#f85149}
    details.payload>pre{margin:0;padding:.5rem .8rem;white-space:pre-wrap;
      font-size:.85em;background:#161b22;border-radius:0 0 8px 8px}
    details.payload.error>pre{color:#ffa198}`

  /**
   * Inline fold controls: expand / collapse every `<details>` at any level,
   * or fold back to the failures-only view (the server-rendered defaults).
   */
  export const FoldScript = `
    (function () {
      var all = function () { return document.querySelectorAll("main details"); };
      var set = function (open, filter) {
        all().forEach(function (d) { d.open = filter ? filter(d) : open; });
      };
      var failuresOnly = function (d) {
        return d.classList.contains("fail") ||
          (d.classList.contains("payload") && d.closest("details.step.fail") != null &&
           !d.classList.contains("input"));
      };
      document.querySelectorAll("nav.fold-controls button").forEach(function (button) {
        button.addEventListener("click", function () {
          var mode = button.getAttribute("data-fold");
          if (mode === "expand") set(true);
          else if (mode === "collapse") set(false);
          else set(false, failuresOnly);
        });
      });
    })();`
}
