import { ActionRegistry, AppAction, ContextMenuItems } from "@wireio/ql-tool-app/common"

describe("ContextMenuItems.of", () => {
  it("builds one enabled item per action, labelled from the registry, in order", () => {
    expect(ContextMenuItems.of(AppAction.selectRows, AppAction.copyCell)).toEqual([
      { action: AppAction.selectRows, label: ActionRegistry.describe(AppAction.selectRows).label, enabled: true },
      { action: AppAction.copyCell, label: "Copy Cell", enabled: true }
    ])
  })

  it("no actions → no items", () => {
    expect(ContextMenuItems.of()).toEqual([])
  })
})
