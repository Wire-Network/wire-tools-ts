import {
  Report,
  ReportCsvRenderer,
  ReportHtmlRenderer,
  ReportMarkdownRenderer,
  ReportRendererRegistry
} from "@wireio/cluster-tool/report"

describe("ReportRendererRegistry", () => {
  it("createDefault maps each format to its renderer ctor", () => {
    const registry = ReportRendererRegistry.createDefault()
    expect(registry.get(Report.Format.csv)).toBe(ReportCsvRenderer)
    expect(registry.get(Report.Format.md)).toBe(ReportMarkdownRenderer)
    expect(registry.get(Report.Format.html)).toBe(ReportHtmlRenderer)
  })

  it("throws for a format with no registered renderer", () => {
    const empty = new ReportRendererRegistry(new Map())
    expect(() => empty.get(Report.Format.csv)).toThrow(
      /No ReportRenderer registered/
    )
  })
})
