import { Menu, type BrowserWindow } from "electron"

import { Deferred } from "@wireio/shared"

import { AppAction, type ContextMenuRequest } from "../../common/index.js"

/** Native context menus resolving to the chosen {@link AppAction}. */
export namespace ContextMenu {
  /**
   * Pop up a native context menu at the cursor.
   *
   * @param window - Owner window.
   * @param request - Items.
   * @returns The chosen action, or `AppAction.none` when dismissed.
   */
  export function popup(window: BrowserWindow, request: ContextMenuRequest): Promise<AppAction> {
    const chosen = new Deferred<AppAction>(),
      menu = Menu.buildFromTemplate(
        request.items.map(({ action, label, enabled }) => ({
          label,
          enabled,
          click: () => chosen.resolveIfUnsettled(action)
        }))
      )
    menu.popup({
      window,
      // The close callback can run before the click handler — let a click win.
      callback: () => setImmediate(() => chosen.resolveIfUnsettled(AppAction.none))
    })
    return chosen.promise
  }
}
