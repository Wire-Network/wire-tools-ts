import {
  colorForLevel,
  formatLocation,
  formatTimestamp,
  parseJsonLogLine
} from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/util/JsonLogRecord.js"

const SampleLine =
  '{"ts":"2026-04-27T19:58:15.417594Z","lvl":"debug","thread":"nodeop","logger":"default","file":"/.../signature_provider_manager_plugin.cpp","line":426,"func":"plugin_initialize","msg":"Registering signature provider"}'

describe("parseJsonLogLine", () => {
  it("returns the typed record for a real sample line", () => {
    const result = parseJsonLogLine(SampleLine)
    expect(typeof result).not.toBe("string")
    if (typeof result === "string") return
    expect(result.ts).toBe("2026-04-27T19:58:15.417594Z")
    expect(result.lvl).toBe("debug")
    expect(result.logger).toBe("default")
    expect(result.line).toBe(426)
    expect(result.msg).toBe("Registering signature provider")
  })

  it("returns the raw line for malformed JSON", () => {
    expect(parseJsonLogLine("not json {")).toBe("not json {")
  })

  it("returns the raw line when JSON parses to a value missing `msg`", () => {
    expect(parseJsonLogLine('{"lvl":"info"}')).toBe('{"lvl":"info"}')
  })

  it("returns the raw line when JSON parses to a non-object (string, number, null)", () => {
    expect(parseJsonLogLine('"plain"')).toBe('"plain"')
    expect(parseJsonLogLine("42")).toBe("42")
    expect(parseJsonLogLine("null")).toBe("null")
  })

  it("returns empty string for empty input", () => {
    expect(parseJsonLogLine("")).toBe("")
  })
})

describe("colorForLevel", () => {
  it("maps the standard level set", () => {
    expect(colorForLevel("trace")).toBe("gray")
    expect(colorForLevel("debug")).toBe("gray")
    expect(colorForLevel("info")).toBeUndefined()
    expect(colorForLevel("warn")).toBe("yellow")
    expect(colorForLevel("error")).toBe("red")
    expect(colorForLevel("fatal")).toBe("redBright")
  })

  it("is case-insensitive", () => {
    expect(colorForLevel("WARN")).toBe("yellow")
    expect(colorForLevel("Error")).toBe("red")
  })

  it("returns undefined for unknown levels", () => {
    expect(colorForLevel("custom")).toBeUndefined()
    expect(colorForLevel("")).toBeUndefined()
  })
})

describe("formatTimestamp", () => {
  it("slices the time-of-day component out of an ISO-8601 string", () => {
    expect(formatTimestamp("2026-04-27T19:58:15.417594Z")).toBe(
      "19:58:15.417"
    )
  })

  it("returns the input unchanged when too short to slice", () => {
    expect(formatTimestamp("short")).toBe("short")
    expect(formatTimestamp("")).toBe("")
  })
})

describe("formatLocation", () => {
  it("returns basename:line for a full path", () => {
    expect(
      formatLocation({
        ts: "",
        lvl: "",
        thread: "",
        logger: "",
        file: "/absolute/path/to/signature_provider_manager_plugin.cpp",
        line: 426,
        func: "",
        msg: ""
      })
    ).toBe("signature_provider_manager_plugin.cpp:426")
  })

  it("returns the bare file:line when there is no slash", () => {
    expect(
      formatLocation({
        ts: "",
        lvl: "",
        thread: "",
        logger: "",
        file: "x.cpp",
        line: 7,
        func: "",
        msg: ""
      })
    ).toBe("x.cpp:7")
  })
})
