import { Menu, type MenuItemConstructorOptions } from "electron"
import { QLPlatform } from "@wireio/ql-shared/node"

import { ActionRegistry, AppAction, ThemeSource } from "../../common/index.js"

/** Delivers a chosen action (to the focused window, or to main for appearance). */
export type ActionDispatcher = (action: AppAction) => void

/** What the application menu is built from. */
export interface ApplicationMenuOptions {
  /** `process.platform` (macOS gets the app menu and keeps Quit there). */
  platform: NodeJS.Platform
  /** Active appearance (checks the matching radio item). */
  themeSource: ThemeSource
  /** Click handler. */
  dispatch: ActionDispatcher
}

/** The native application menu: File / Edit / View / Query / Window / Help (+ the macOS app menu). */
export namespace ApplicationMenu {
  /** Appearance radio items in display order. */
  export const AppearanceActions: ReadonlyArray<[AppAction, ThemeSource]> = [
    [AppAction.appearanceSystem, ThemeSource.system],
    [AppAction.appearanceLight, ThemeSource.light],
    [AppAction.appearanceDark, ThemeSource.dark]
  ] as const

  /**
   * One menu item for an action (label + accelerator from {@link ActionRegistry}).
   *
   * @param action - The action.
   * @param dispatch - Click handler.
   * @returns The item.
   */
  export function actionItem(action: AppAction, dispatch: ActionDispatcher): MenuItemConstructorOptions {
    const { label, accelerator } = ActionRegistry.describe(action)
    return { label, accelerator, click: () => dispatch(action) }
  }

  /**
   * The full template.
   *
   * @param options - Platform, appearance and click handler.
   * @returns The template.
   */
  export function template(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
    const { platform, themeSource, dispatch } = options,
      isMac = platform === QLPlatform.darwin,
      item = (action: AppAction) => actionItem(action, dispatch),
      separator: MenuItemConstructorOptions = { type: "separator" }
    return [
      ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
      {
        label: "File",
        submenu: [
          item(AppAction.newTab),
          item(AppAction.openFile),
          item(AppAction.saveFile),
          separator,
          item(AppAction.exportResults),
          separator,
          item(AppAction.closeTab),
          ...(isMac ? [] : [separator, { role: "quit" } as MenuItemConstructorOptions])
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          separator,
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          separator,
          item(AppAction.find),
          item(AppAction.formatQuery)
        ]
      },
      {
        label: "View",
        submenu: [
          {
            label: "Appearance",
            submenu: AppearanceActions.map(([action, source]) => ({
              ...item(action),
              type: "radio",
              checked: source === themeSource
            }))
          },
          separator,
          item(AppAction.toggleHistory),
          item(AppAction.toggleSaved),
          separator,
          { role: "reload" },
          { role: "toggleDevTools" },
          separator,
          { role: "togglefullscreen" }
        ]
      },
      {
        label: "Query",
        submenu: [
          item(AppAction.run),
          item(AppAction.runSelection),
          item(AppAction.stop),
          item(AppAction.retry),
          separator,
          item(AppAction.saveQuery),
          item(AppAction.refreshCatalog),
          item(AppAction.connections),
          separator,
          item(AppAction.restartQueryHost)
        ]
      },
      { role: "windowMenu" },
      { role: "help", submenu: [{ role: "about" }] }
    ]
  }

  /**
   * Build and install the application menu.
   *
   * @param options - Platform, appearance and click handler.
   * @returns The installed menu.
   */
  export function install(options: ApplicationMenuOptions): Menu {
    const menu = Menu.buildFromTemplate(template(options))
    Menu.setApplicationMenu(menu)
    return menu
  }
}
