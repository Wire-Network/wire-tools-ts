import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { LogRecord } from "@wireio/shared"
import { LogFileAppender } from "@wireio/cluster-tool/logging"

const record = (over: Partial<LogRecord>): LogRecord => ({
  timestamp: 0,
  category: "cat",
  level: "info",
  message: "msg",
  ...over
})

describe("LogFileAppender", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "logfile-"))
    file = Path.join(dir, "sub", "run.log")
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates parent directories and writes jsonl by default", async () => {
    const appender = new LogFileAppender({ filename: file, level: "info" })
    appender.append(record({ message: "hello" }))
    await appender.close()
    const first = Fs.readFileSync(file, "utf8").trim().split("\n")[0]
    expect(JSON.parse(first).message).toBe("hello")
  })

  it("writes the text format when configured", async () => {
    const appender = new LogFileAppender({
      filename: file,
      level: "info",
      format: LogFileAppender.Format.text
    })
    appender.append(record({ message: "hello", category: "cat", level: "warn" }))
    await appender.close()
    expect(Fs.readFileSync(file, "utf8")).toMatch(/\[cat\] \(warn\) hello/)
  })

  it("drops records below the configured level", async () => {
    const appender = new LogFileAppender({ filename: file, level: "warn" })
    appender.append(record({ level: "info", message: "skipme" }))
    appender.append(record({ level: "error", message: "keepme" }))
    await appender.close()
    const content = Fs.readFileSync(file, "utf8")
    expect(content).not.toMatch(/skipme/)
    expect(content).toMatch(/keepme/)
  })

  it("uses a custom formatter when supplied", async () => {
    const appender = new LogFileAppender({
      filename: file,
      level: "info",
      formatter: r => `CUSTOM:${r.message}`
    })
    appender.append(record({ message: "x" }))
    await appender.close()
    expect(Fs.readFileSync(file, "utf8").trim()).toBe("CUSTOM:x")
  })
})
