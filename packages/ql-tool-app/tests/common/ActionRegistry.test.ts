import { ActionRegistry, AppAction } from "@wireio/ql-tool-app/common"

/** Every accelerated action and its exact accelerator (the documented workbench chords). */
const ExpectedAccelerators: ReadonlyArray<readonly [AppAction, string]> = [
  [AppAction.run, "CmdOrCtrl+Enter"],
  [AppAction.runSelection, "CmdOrCtrl+Shift+Enter"],
  [AppAction.stop, "CmdOrCtrl+."],
  [AppAction.newTab, "CmdOrCtrl+T"],
  [AppAction.closeTab, "CmdOrCtrl+W"],
  [AppAction.openFile, "CmdOrCtrl+O"],
  [AppAction.saveFile, "CmdOrCtrl+S"],
  [AppAction.exportResults, "CmdOrCtrl+E"],
  [AppAction.formatQuery, "Shift+Alt+F"],
  [AppAction.find, "CmdOrCtrl+F"],
  [AppAction.refreshCatalog, "F5"],
  [AppAction.connections, "CmdOrCtrl+,"],
  [AppAction.toggleHistory, "CmdOrCtrl+Shift+H"],
  [AppAction.toggleSaved, "CmdOrCtrl+Shift+L"],
  [AppAction.saveQuery, "CmdOrCtrl+Shift+S"]
] as const

describe("ActionRegistry", () => {
  it("describes every action, with a label for everything but none", () => {
    Object.values(AppAction).forEach(action => {
      const { label } = ActionRegistry.describe(action)
      expect(label.length > 0).toBe(action !== AppAction.none)
    })
  })

  it("accelerators are unique", () => {
    const accelerators = Object.values(ActionRegistry.Descriptors)
      .map(descriptor => descriptor.accelerator)
      .filter(accelerator => accelerator != null)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it.each(ExpectedAccelerators)("%s is bound to %s", (action, accelerator) => {
    expect(ActionRegistry.describe(action).accelerator).toBe(accelerator)
  })

  it("only the pinned actions carry an accelerator (no unpinned chord slips in)", () => {
    const pinned = new Set(ExpectedAccelerators.map(([action]) => action))
    Object.values(AppAction)
      .filter(action => !pinned.has(action))
      .forEach(action => expect(ActionRegistry.describe(action).accelerator).toBeUndefined())
  })
})

describe("ActionRegistry text", () => {
  it("labels Select Rows from SelectRowsLimit", () => {
    expect(ActionRegistry.describe(AppAction.selectRows).label).toBe(`Select Rows (LIMIT ${ActionRegistry.SelectRowsLimit})`)
  })

  it("acceleratorText reads CmdOrCtrl as Ctrl/Cmd and keeps other parts; none when unbound", () => {
    expect(ActionRegistry.acceleratorText(AppAction.run)).toBe("Ctrl/Cmd+Enter")
    expect(ActionRegistry.acceleratorText(AppAction.formatQuery)).toBe("Shift+Alt+F")
    expect(ActionRegistry.acceleratorText(AppAction.refreshCatalog)).toBe("F5")
    expect(ActionRegistry.acceleratorText(AppAction.retry)).toBeUndefined()
  })

  it("tooltip appends the accelerator text when bound", () => {
    expect(ActionRegistry.tooltip(AppAction.runSelection)).toBe("Run Selection (Ctrl/Cmd+Shift+Enter)")
    expect(ActionRegistry.tooltip(AppAction.retry)).toBe("Retry")
  })
})
