import type { Renderer } from "../utils/Renderer.js"
import type { Report } from "./Report.js"

/**
 * A report format renderer. Extends the shared `utils/Renderer` — `render()`
 * returns the rendered document; the {@link Report} is supplied through the
 * constructor, not as a `render(report)` argument.
 */
export interface ReportRenderer extends Renderer {
  readonly format: Report.Format
}

/** Constructor signature for a {@link ReportRenderer} — `new (report) => T`. */
export type ReportRendererConstructor<T extends ReportRenderer = ReportRenderer> = new (
  report: Report
) => T
