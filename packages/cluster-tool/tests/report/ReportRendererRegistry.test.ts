import {
  Report,
  ReportCsvRenderer,
  ReportHtmlRenderer,
  ReportJsonRenderer,
  ReportMarkdownRenderer,
  ReportRendererRegistry
} from "@wireio/cluster-tool/report"

describe("ReportRendererRegistry", () => {
  it("createDefault maps each format to its renderer ctor", () => {
    const registry = ReportRendererRegistry.createDefault()
    expect(registry.get(Report.Format.csv)).toBe(ReportCsvRenderer)
    expect(registry.get(Report.Format.md)).toBe(ReportMarkdownRenderer)
    expect(registry.get(Report.Format.html)).toBe(ReportHtmlRenderer)
    expect(registry.get(Report.Format.json)).toBe(ReportJsonRenderer)
  })

  it("registers a renderer for EVERY declared format", () => {
    // A format in the enum with no renderer throws only when a run selects it,
    // which is the worst moment to find out — the registry must cover the enum.
    const registry = ReportRendererRegistry.createDefault()
    Object.values(Report.Format).forEach(format =>
      expect(() => registry.get(format)).not.toThrow()
    )
  })

  it("throws for a format with no registered renderer", () => {
    const empty = new ReportRendererRegistry(new Map())
    expect(() => empty.get(Report.Format.csv)).toThrow(
      /No ReportRenderer registered/
    )
  })
})
