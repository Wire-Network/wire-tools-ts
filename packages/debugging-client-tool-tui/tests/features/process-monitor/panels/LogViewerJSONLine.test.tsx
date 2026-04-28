import React from "react"
import {
  LogViewerJSONLine,
  jsonColumnBoundaries,
  nextColumnOffset,
  prevColumnOffset
} from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/panels/LogViewerJSONLine.js"

const SampleLine =
  '{"ts":"2026-04-27T19:58:15.417594Z","lvl":"debug","thread":"nodeop","logger":"default","file":"/.../x.cpp","line":426,"func":"plugin_initialize","msg":"Registering signature provider"}'

/** Shorthand: invoke the renderer with default test props. */
function render(
  overrides: Partial<{
    line: string
    horizontalOffset: number
    highlight: string
    locationVisible: boolean
  }> = {}
): React.ReactElement {
  return LogViewerJSONLine({
    line: SampleLine,
    horizontalOffset: 0,
    highlight: "",
    locationVisible: false,
    ...overrides
  })
}

describe("LogViewerJSONLine", () => {
  it("is a React function component", () => {
    expect(typeof LogViewerJSONLine).toBe("function")
  })

  it("renders a structured row for a valid JSONL line", () => {
    const element = render()
    expect(React.isValidElement(element)).toBe(true)
    const serialized = JSON.stringify(element)
    expect(serialized).toContain("19:58:15.417")
    expect(serialized).toContain("debug")
    expect(serialized).toContain("default")
    expect(serialized).toContain("Registering signature provider")
  })

  it("renders malformed lines verbatim and dimmed", () => {
    const element = render({ line: "not json" })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain("not json")
    expect(serialized).toContain('"dimColor":true')
  })

  it("highlights search matches in the message column", () => {
    const element = render({ highlight: "signature" })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain('"inverse":true')
    expect(serialized).toContain("signature")
  })

  it("renders the parsed row with truncate-end wrap mode", () => {
    expect((render().props as { wrap?: string }).wrap).toBe("truncate-end")
  })

  it("renders the malformed-line fallback with truncate-end wrap mode", () => {
    expect(
      (render({ line: "not json" }).props as { wrap?: string }).wrap
    ).toBe("truncate-end")
  })

  it("hides the source-location column when locationVisible=false", () => {
    const serialized = JSON.stringify(render({ locationVisible: false }))
    expect(serialized).not.toContain("x.cpp:426")
  })

  it("shows the source-location column when locationVisible=true", () => {
    const serialized = JSON.stringify(render({ locationVisible: true }))
    expect(serialized).toContain("x.cpp:426")
  })

  describe("horizontal pan applies uniformly across the row", () => {
    /** Width breakdown matching the JSONL renderer: time(12) sep(1) level(5) sep(1) [logger](31) sep(1) = 51 before msg. */
    const MsgStartOffset = 51

    it("panning past the timestamp column drops it from the rendered output", () => {
      // Offset 13 = timestamp(12) + 1-char separator → timestamp fully scrolled
      // off; level + later columns remain.
      const serialized = JSON.stringify(render({ horizontalOffset: 13 }))
      expect(serialized).not.toContain("19:58:15.417")
      expect(serialized).toContain("debug")
      expect(serialized).toContain("Registering signature provider")
    })

    it("panning past every leading column leaves only the msg", () => {
      const serialized = JSON.stringify(
        render({ horizontalOffset: MsgStartOffset })
      )
      expect(serialized).not.toContain("19:58:15.417")
      expect(serialized).not.toContain("[default]")
      expect(serialized).toContain("Registering signature provider")
    })

    it("panning further into the msg slices the msg too", () => {
      // 13 chars into the msg drops "Registering s".
      const serialized = JSON.stringify(
        render({ horizontalOffset: MsgStartOffset + 13 })
      )
      expect(serialized).not.toContain("Registering signature provider")
      expect(serialized).toContain("ignature provider")
    })
  })
})

describe("jsonColumnBoundaries", () => {
  it("computes the time/level/category/msg boundaries when location is hidden", () => {
    expect(jsonColumnBoundaries(false)).toEqual([0, 13, 19, 51])
  })

  it("inserts the location boundary between category and msg when visible", () => {
    expect(jsonColumnBoundaries(true)).toEqual([0, 13, 19, 51, 84])
  })
})

describe("nextColumnOffset / prevColumnOffset", () => {
  const Boundaries = jsonColumnBoundaries(false)

  it("nextColumnOffset jumps to the next boundary", () => {
    expect(nextColumnOffset(Boundaries, 0, 8)).toBe(13)
    expect(nextColumnOffset(Boundaries, 13, 8)).toBe(19)
    expect(nextColumnOffset(Boundaries, 25, 8)).toBe(51)
  })

  it("nextColumnOffset falls back to a fixed step past the last boundary", () => {
    expect(nextColumnOffset(Boundaries, 51, 8)).toBe(59)
    expect(nextColumnOffset(Boundaries, 100, 8)).toBe(108)
  })

  it("prevColumnOffset snaps back to the previous boundary", () => {
    expect(prevColumnOffset(Boundaries, 51, 8)).toBe(19)
    expect(prevColumnOffset(Boundaries, 25, 8)).toBe(19)
    expect(prevColumnOffset(Boundaries, 13, 8)).toBe(0)
    expect(prevColumnOffset(Boundaries, 0, 8)).toBe(0)
  })

  it("prevColumnOffset stays fine-grained inside the msg column", () => {
    // 100 is well past msg start (51) — should step back by HorizontalStep, not jump to 51.
    expect(prevColumnOffset(Boundaries, 100, 8)).toBe(92)
  })

  it("plain-text mode (no boundaries) always falls back to the fixed step", () => {
    const empty: readonly number[] = []
    expect(nextColumnOffset(empty, 0, 8)).toBe(8)
    expect(nextColumnOffset(empty, 16, 8)).toBe(24)
    expect(prevColumnOffset(empty, 16, 8)).toBe(8)
    expect(prevColumnOffset(empty, 0, 8)).toBe(0)
  })
})
