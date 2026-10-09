/**
 * @jest-environment jsdom
 */
import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { getLoggingManager, type LogRecord } from "@wireio/shared"

import { PanelErrorBoundary } from "@wireio/ql-tool-app/renderer/components"

/** Throws while `fail` is set (module-level so the reload can clear it). */
let fail = true

/** A panel that throws on render while {@link fail} is true. */
function Fragile() {
  const [label] = useState("panel body")
  if (fail) throw new Error("render exploded")
  return <span>{label}</span>
}

describe("PanelErrorBoundary", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  it("replaces a crashed panel with the inline fallback, and Reload recovers", () => {
    render(
      <PanelErrorBoundary panel="Results">
        <Fragile />
      </PanelErrorBoundary>
    )
    expect(screen.getByText(`Results: ${PanelErrorBoundary.FailedText} — render exploded`)).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByText(PanelErrorBoundary.ReloadLabel))
    expect(screen.getByText("panel body")).toBeInTheDocument()
  })

  it("a healthy panel renders its children", () => {
    fail = false
    render(
      <PanelErrorBoundary panel="Navigator">
        <Fragile />
      </PanelErrorBoundary>
    )
    expect(screen.getByText("panel body")).toBeInTheDocument()
  })

  it("logs the failure with the error object itself (its stack survives) and the component stack", () => {
    const manager = getLoggingManager(),
      previous = [...manager.appenders],
      records: LogRecord[] = []
    manager.setAppenders({ append: (record: LogRecord) => records.push(record) } as never)
    try {
      fail = true
      render(
        <PanelErrorBoundary panel="Grid">
          <Fragile />
        </PanelErrorBoundary>
      )
      const logged = records.find(record => String(record.message).startsWith("Grid panel failed: render exploded"))
      expect(logged.args[0]).toBeInstanceOf(Error)
      expect(typeof logged.args[1]).toBe("string")
    } finally {
      manager.setAppenders(previous)
      fail = false
    }
  })
})
