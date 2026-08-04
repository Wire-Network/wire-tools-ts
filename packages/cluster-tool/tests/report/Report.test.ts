import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  Report,
  ReportRendererRegistry
} from "@wireio/cluster-tool/report"
import {
  createFailureReport,
  createSkippedTailReport,
  createSuccessReport
} from "./reportFixture.js"

describe("Report.StepResult factories", () => {
  const step: Report.StepLike = {
    name: "s",
    description: "d",
    actor: Report.Actor.User,
    input: { x: 1 }
  }

  it("ok → status ok, no error, input preserved, ISO startedAt", () => {
    const result = Report.StepResult.ok(step, 100)
    expect(result.status).toBe(Report.StepStatus.ok)
    expect(result.durationMs).toBe(100)
    expect(result.error).toBeNull()
    expect(result.input).toEqual({ x: 1 })
    expect(() => new Date(result.startedAt).toISOString()).not.toThrow()
  })

  it("failed → status failed, ErrorDetail built from the thrown value + step input", () => {
    const result = Report.StepResult.failed(step, 300, new Error("boom"))
    expect(result.status).toBe(Report.StepStatus.failed)
    expect(result.error?.message).toBe("boom")
    expect(result.error?.stack).toContain("boom")
    expect(result.error?.input).toEqual({ x: 1 })
  })

  it("skipped → status skipped, zero duration, no error", () => {
    const result = Report.StepResult.skipped(step)
    expect(result.status).toBe(Report.StepStatus.skipped)
    expect(result.durationMs).toBe(0)
    expect(result.error).toBeNull()
  })
})

describe("Report.ErrorDetail.from", () => {
  it("extracts message + stack from an Error", () => {
    const detail = Report.ErrorDetail.from(new Error("kaboom"))
    expect(detail.message).toBe("kaboom")
    expect(detail.stack).toContain("kaboom")
    expect(detail.processOutput).toBeNull()
    expect(detail.input).toBeNull()
  })

  it("stringifies a non-Error, with null stack", () => {
    const detail = Report.ErrorDetail.from("plain failure")
    expect(detail.message).toBe("plain failure")
    expect(detail.stack).toBeNull()
  })

  it("carries the supplied input + processOutput", () => {
    const detail = Report.ErrorDetail.from(new Error("x"), { a: 1 }, "child stderr")
    expect(detail.input).toEqual({ a: 1 })
    expect(detail.processOutput).toBe("child stderr")
  })
})

describe("Report.PhaseBuilder + Report", () => {
  it("succeeded reflects the steps (all ok → true; any failed → false)", () => {
    expect(createSuccessReport().succeeded).toBe(true)
    expect(createFailureReport().succeeded).toBe(false)
  })

  it("a skipped step fails its phase — every step must be ok to succeed", () => {
    const report = createSkippedTailReport()
    expect(report.phases[0].succeeded).toBe(false)
    expect(report.succeeded).toBe(false)
  })

  it("Phase.skippedCount counts the skipped steps", () => {
    expect(Report.Phase.skippedCount(createSkippedTailReport().phases[0])).toBe(2)
    expect(Report.Phase.skippedCount(createSuccessReport().phases[0])).toBe(0)
  })

  it("push + phases expose the recorded phases", () => {
    const report = createFailureReport()
    expect(report.phases.map(phase => phase.name)).toEqual(["Deploy", "DepositSOL"])
    expect(report.phases[1].succeeded).toBe(false)
  })
})

describe("Report.title / Report.timestampLine", () => {
  it("titles a named run with its verdict", () => {
    const report = new Report()
    report.name = "flow-swap-with-underwriting"
    expect(Report.title(report)).toBe("flow-swap-with-underwriting: SUCCESS")
    const failed = createFailureReport()
    failed.name = "flow-swap-with-underwriting"
    expect(Report.title(failed)).toBe("flow-swap-with-underwriting: FAILED")
  })

  it("falls back to the default name for unnamed (CLI) runs", () => {
    expect(Report.title(new Report())).toBe(`${Report.DefaultName}: SUCCESS`)
  })

  it("timestampLine renders the same instant in UTC and Eastern", () => {
    const line = Report.timestampLine(new Date("2026-01-15T19:52:08Z"))
    expect(line).toBe("2026-01-15 19:52:08 UTC · 2026-01-15 14:52:08 EST")
  })

  it("timestampLine tracks daylight saving (EDT in summer)", () => {
    const line = Report.timestampLine(new Date("2026-07-03T19:52:08Z"))
    expect(line).toBe("2026-07-03 19:52:08 UTC · 2026-07-03 15:52:08 EDT")
  })
})

describe("Report.write", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "report-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("renders every configured format to <path>/<basename>.<format>", async () => {
    await createFailureReport().write(
      {
        path: dir,
        basename: "run",
        formats: [Report.Format.csv, Report.Format.md, Report.Format.html]
      },
      ReportRendererRegistry.createDefault()
    )
    const csv = Fs.readFileSync(Path.join(dir, "run.csv"), "utf8")
    const md = Fs.readFileSync(Path.join(dir, "run.md"), "utf8")
    const html = Fs.readFileSync(Path.join(dir, "run.html"), "utf8")
    expect(csv.split("\n")[0]).toBe(
      "path,phase,step,actor,status,startedAt,durationMs,error,extra"
    )
    expect(md).toContain("# cluster-build: FAILED")
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("cluster-build: FAILED")
  })
})

describe("Report.title verdicts", () => {
  it("all-ok → SUCCESS", () => {
    expect(Report.title(createSuccessReport())).toBe(
      `cluster-build: ${Report.Verdict.SUCCESS}`
    )
  })

  it("a failed step → FAILED", () => {
    expect(Report.title(createFailureReport())).toBe(
      `cluster-build: ${Report.Verdict.FAILED}`
    )
  })

  it("interrupted wins over succeeded — a killed run is never a SUCCESS", () => {
    const report = createSuccessReport()
    report.interrupted = true
    expect(report.succeeded).toBe(true) // the completed phases really did pass…
    expect(Report.title(report)).toBe(
      `cluster-build: ${Report.Verdict.INTERRUPTED}`
    ) // …but the RUN did not finish
  })

  it("an EMPTY interrupted report is not a SUCCESS either", () => {
    const report = new Report()
    report.interrupted = true
    expect(report.succeeded).toBe(true) // every() over zero nodes is vacuously true
    expect(Report.title(report)).toBe(
      `cluster-build: ${Report.Verdict.INTERRUPTED}`
    )
  })
})

describe("Report.writeSync", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "report-sync-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("renders every configured format, creating the directory", () => {
    const nested = Path.join(dir, "reports")
    createFailureReport().writeSync(
      {
        path: nested,
        basename: "run",
        formats: [Report.Format.csv, Report.Format.md, Report.Format.html]
      },
      ReportRendererRegistry.createDefault()
    )
    expect(Fs.readFileSync(Path.join(nested, "run.csv"), "utf8").split("\n")[0]).toBe(
      "path,phase,step,actor,status,startedAt,durationMs,error,extra"
    )
    expect(Fs.readFileSync(Path.join(nested, "run.md"), "utf8")).toContain(
      "# cluster-build: FAILED"
    )
    expect(Fs.readFileSync(Path.join(nested, "run.html"), "utf8")).toContain(
      "<!doctype html>"
    )
  })

  it("produces byte-identical output to the async write", async () => {
    // ONE report instance — the fixture stamps `startedAt` at build time, so two
    // instances differ by a millisecond and would fail for the wrong reason.
    const report = createSuccessReport(),
      asyncDir = Path.join(dir, "async"),
      syncDir = Path.join(dir, "sync"),
      config = (path: string) => ({
        path,
        basename: "run",
        formats: [Report.Format.csv]
      })
    await report.write(config(asyncDir), ReportRendererRegistry.createDefault())
    report.writeSync(config(syncDir), ReportRendererRegistry.createDefault())
    expect(Fs.readFileSync(Path.join(syncDir, "run.csv"), "utf8")).toBe(
      Fs.readFileSync(Path.join(asyncDir, "run.csv"), "utf8")
    )
  })

  it("throws when a configured format has no renderer", () => {
    expect(() =>
      createSuccessReport().writeSync(
        { path: dir, basename: "run", formats: [Report.Format.csv] },
        new ReportRendererRegistry(new Map())
      )
    ).toThrow(/No ReportRenderer registered/)
  })
})
