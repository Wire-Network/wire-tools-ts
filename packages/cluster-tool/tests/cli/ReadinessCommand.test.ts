import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createReadinessCommand,
  ReadinessCommand
} from "@wireio/cluster-tool/cli/ReadinessCommand"
import { Report } from "@wireio/cluster-tool/report"

describe("ReadinessCommand", () => {
  it("registers a standalone readiness command", () => {
    const command = createReadinessCommand()
    expect(command.command).toBe(ClusterCommand.readiness)
    expect(typeof command.builder).toBe("function")
    expect(typeof command.handler).toBe("function")
  })

  it("defaults to the native Markdown and HTML report renderers", () => {
    expect(ReadinessCommand.DefaultReportFormats).toEqual([
      Report.Format.md,
      Report.Format.html
    ])
    expect(ReadinessCommand.ReportName).toBe("cluster-readiness")
  })
})
