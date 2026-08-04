import Fs, { promises as Fsp } from "node:fs"
import Path from "node:path"

import type { ClusterReadinessReport } from "@wireio/cluster-tool-shared"
import { Deferred } from "@wireio/shared"

import type { Report } from "../report/Report.js"
import { ReportHtmlRenderer } from "../report/renderers/ReportHtmlRenderer.js"

/** Default gitignored report root relative to the caller's working directory. */
export const DefaultReadinessReportDirectory = "readiness-reports"

/** Destination controls for one readiness archive. */
export interface ReadinessReportExportOptions {
  /** Archive root. Defaults to ./readiness-reports. */
  rootPath?: string
}

/** Names and absolute path written by one readiness archive. */
export interface ReadinessReportArchive {
  reportName: string
  archiveFile: string
  jsonFileName: string
  htmlFileName: string
}

/** Export the machine report and native orchestration HTML as one tar.gz. */
export class ReadinessReportExporter {
  /** Creates an exporter for one completed readiness run. */
  constructor(
    private readonly readinessReport: ClusterReadinessReport,
    private readonly orchestrationReport: Report,
    private readonly options: ReadinessReportExportOptions = {}
  ) {}

  /** Write one compressed archive and return its member names. */
  async exportArchive(): Promise<ReadinessReportArchive> {
    const report = this.readinessReport,
      rootPath = Path.resolve(
        this.options.rootPath ??
          Path.join(process.cwd(), DefaultReadinessReportDirectory)
      ),
      chainId =
        report.observedWireChainId ?? report.requestedWireChainId ?? "unknown",
      reportName = [
        "wire-cluster",
        safeSegment(chainId).slice(0, 12).toLowerCase(),
        safeSegment(report.feature),
        "readiness-report",
        safeSegment(report.generatedAt)
      ].join("-"),
      jsonFileName = `${reportName}.json`,
      htmlFileName = `${reportName}.html`,
      archiveFile = Path.join(rootPath, `${reportName}.tar.gz`),
      generatedAtMs = Date.parse(report.generatedAt),
      modifiedAt = new Date(Number.isNaN(generatedAtMs) ? 0 : generatedAtMs)

    await Fsp.mkdir(rootPath, { recursive: true })
    const { TarArchive } = await import("archiver"),
      archive = new TarArchive({ gzip: true, gzipOptions: { level: 9 } }),
      output = Fs.createWriteStream(archiveFile),
      complete = new Deferred<void>()

    output.on("close", () => complete.resolve())
    output.on("error", error => complete.reject(error))
    archive.on("error", error => complete.reject(error))
    archive.pipe(output)
    archive.append(`${JSON.stringify(report, null, 2)}\n`, {
      name: jsonFileName,
      date: modifiedAt,
      mode: 0o644
    })
    archive.append(new ReportHtmlRenderer(this.orchestrationReport).render(), {
      name: htmlFileName,
      date: modifiedAt,
      mode: 0o644
    })
    await archive.finalize()
    await complete.promise

    return { reportName, archiveFile, jsonFileName, htmlFileName }
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "") || "unknown"
}
