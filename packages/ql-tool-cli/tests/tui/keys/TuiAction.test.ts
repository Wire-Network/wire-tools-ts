import { TuiAction } from "@wireio/ql-tool-cli/tui/index.js"

describe("TuiAction", () => {
  it("is an identity enum with `none` for unbound chords", () => {
    Object.entries(TuiAction).forEach(([name, value]) => expect(value).toBe(name))
    expect(TuiAction.none).toBe("none")
  })
})
