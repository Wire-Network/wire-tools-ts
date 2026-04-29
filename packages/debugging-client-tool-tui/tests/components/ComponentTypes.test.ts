/**
 * PanelComponent and StatusBarComponent are type-only modules — FunctionComponent
 * extensions carrying a required static `id` (and `title` for panels). These
 * tests verify a concrete conformer compiles and reports the statics correctly.
 */
import React from "react"
import type { PanelComponentType } from "@wireio/debugging-client-tool-tui/components/PanelComponent.js"
import type { StatusBarComponentType } from "@wireio/debugging-client-tool-tui/components/StatusBarComponent.js"

describe("PanelComponentType", () => {
  it("a concrete conformer exposes the statics", () => {
    function TestPanel() {
      return React.createElement("div")
    }
    TestPanel.id = "test:panel" as const
    TestPanel.title = "Test Panel" as const
    const Typed: PanelComponentType = TestPanel
    expect(Typed.id).toBe("test:panel")
    expect(Typed.title).toBe("Test Panel")
    expect(typeof Typed).toBe("function")
  })
})

describe("StatusBarComponentType", () => {
  it("a concrete conformer exposes the id static", () => {
    function TestWidget() {
      return React.createElement("span")
    }
    TestWidget.id = "test:widget" as const
    const Typed: StatusBarComponentType = TestWidget
    expect(Typed.id).toBe("test:widget")
    expect(typeof Typed).toBe("function")
  })
})
