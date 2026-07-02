import Assert from "node:assert"
import { Report } from "./Report.js"
import type { ReportRendererConstructor } from "./ReportRenderer.js"
import { ReportCsvRenderer } from "./renderers/ReportCsvRenderer.js"
import { ReportMarkdownRenderer } from "./renderers/ReportMarkdownRenderer.js"
import { ReportHtmlRenderer } from "./renderers/ReportHtmlRenderer.js"

/**
 * Format → renderer constructor, assembled explicitly (a constructor argument),
 * so output depends on imports + constructor args, NOT on module-import side
 * effects — renderers never self-register. {@link Report.write} consults this.
 */
export class ReportRendererRegistry {
  constructor(
    private readonly renderers: ReadonlyMap<Report.Format, ReportRendererConstructor>
  ) {}

  /** The constructor registered for `format` (throws when none is). */
  get(format: Report.Format): ReportRendererConstructor {
    const constructor = this.renderers.get(format)
    Assert.ok(constructor, `No ReportRenderer registered for format ${format}`)
    return constructor
  }

  /** The built-in csv/md/html registry. */
  static createDefault(): ReportRendererRegistry {
    return new ReportRendererRegistry(
      new Map<Report.Format, ReportRendererConstructor>([
        [Report.Format.csv, ReportCsvRenderer],
        [Report.Format.md, ReportMarkdownRenderer],
        [Report.Format.html, ReportHtmlRenderer]
      ])
    )
  }
}
