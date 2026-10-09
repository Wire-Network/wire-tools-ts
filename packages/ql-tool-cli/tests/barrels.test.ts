import * as cli from "@wireio/ql-tool-cli/cli/index.js"
import * as tui from "@wireio/ql-tool-cli/tui/index.js"

describe("barrels", () => {
  it("expose the CLI surface", () => {
    expect(Object.keys(cli)).toEqual(expect.arrayContaining(["main", "executeCommandLine", "createQLParser", "QLExitCode", "CliContext", "QueryCommand", "importTuiModule"]))
  })

  it("expose the TUI surface", () => {
    expect(Object.keys(tui)).toEqual(expect.arrayContaining(["runTui", "App", "KeyBindings", "TuiServiceRegistry", "createTuiStore", "WorkbenchRoute", "ListRoute"]))
  })
})
