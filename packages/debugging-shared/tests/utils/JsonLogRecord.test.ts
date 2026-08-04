import {
  JsonLogLevel,
  JsonLogRecordSchemaCodec,
  LogLevelColor,
  colorForLevel,
  formatLocation,
  formatTimestamp,
  parseJsonLogLine,
  type JsonLogRecord
} from "@wireio/debugging-shared"

const fullRecord: JsonLogRecord = {
  ts: "2026-04-27T19:58:15.417594Z",
  lvl: JsonLogLevel.info,
  thread: "nodeop",
  logger: "default",
  file: "/x/y/z.cpp",
  line: 1,
  func: "f",
  msg: "hello"
}

describe("JsonLogRecordSchemaCodec", () => {
  it("round-trips a record through serialize → deserialize", () => {
    expect(
      JsonLogRecordSchemaCodec.deserialize(
        JsonLogRecordSchemaCodec.serialize(fullRecord)
      )
    ).toEqual(fullRecord)
  })

  it("check accepts a full record and rejects a partial one", () => {
    expect(JsonLogRecordSchemaCodec.check(fullRecord)).toBe(true)
    expect(JsonLogRecordSchemaCodec.check({ msg: "hi" })).toBe(false)
  })

  it("deserialize throws on a structurally-invalid record (wrong field type)", () => {
    expect(() =>
      JsonLogRecordSchemaCodec.deserialize(JSON.stringify({ ...fullRecord, line: "x" }))
    ).toThrow()
  })
})

describe("parseJsonLogLine", () => {
  it("returns the empty string verbatim for empty input", () => {
    expect(parseJsonLogLine("")).toBe("")
  })

  it("returns raw line when JSON.parse fails", () => {
    expect(parseJsonLogLine("not json")).toBe("not json")
  })

  it("returns raw line when parsed value lacks a `msg` string", () => {
    expect(parseJsonLogLine(JSON.stringify({ ts: "x" }))).toEqual(
      JSON.stringify({ ts: "x" })
    )
  })

  it("returns the parsed record for a full structured record", () => {
    expect(parseJsonLogLine(JSON.stringify(fullRecord))).toEqual(fullRecord)
  })
})

describe("colorForLevel", () => {
  it("maps trace/debug to gray", () => {
    expect(colorForLevel("trace")).toBe(LogLevelColor.gray)
    expect(colorForLevel("debug")).toBe(LogLevelColor.gray)
  })

  it("returns undefined for info", () => {
    expect(colorForLevel("info")).toBeUndefined()
  })

  it("maps warn to yellow, error to red, fatal to redBright", () => {
    expect(colorForLevel("warn")).toBe(LogLevelColor.yellow)
    expect(colorForLevel("error")).toBe(LogLevelColor.red)
    expect(colorForLevel("fatal")).toBe(LogLevelColor.redBright)
  })

  it("falls back to undefined for unknown levels", () => {
    expect(colorForLevel("notice")).toBeUndefined()
  })
})

describe("formatTimestamp", () => {
  it("slices ISO-8601 timestamp to HH:mm:ss.SSS", () => {
    expect(formatTimestamp("2026-04-27T19:58:15.417594Z")).toBe("19:58:15.417")
  })

  it("returns short timestamps verbatim when there's nothing to slice", () => {
    expect(formatTimestamp("2026")).toBe("2026")
  })
})

describe("formatLocation", () => {
  it("returns basename:line", () => {
    expect(
      formatLocation({
        ts: "",
        lvl: "info",
        thread: "",
        logger: "",
        file: "/a/b/c.cpp",
        line: 42,
        func: "",
        msg: ""
      })
    ).toBe("c.cpp:42")
  })

  it("handles a bare filename", () => {
    expect(
      formatLocation({
        ts: "",
        lvl: "info",
        thread: "",
        logger: "",
        file: "x.cpp",
        line: 1,
        func: "",
        msg: ""
      })
    ).toBe("x.cpp:1")
  })
})
