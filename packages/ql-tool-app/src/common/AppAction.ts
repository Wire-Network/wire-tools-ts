/**
 * Every user-invocable workbench action (identity enum). Menu items, accelerators,
 * context menus and toolbar buttons all resolve to one of these; `none` is the
 * result of a dismissed context menu.
 */
export enum AppAction {
  none = "none",
  run = "run",
  runSelection = "runSelection",
  stop = "stop",
  retry = "retry",
  newTab = "newTab",
  closeTab = "closeTab",
  openFile = "openFile",
  saveFile = "saveFile",
  exportResults = "exportResults",
  formatQuery = "formatQuery",
  find = "find",
  refreshCatalog = "refreshCatalog",
  connections = "connections",
  toggleHistory = "toggleHistory",
  toggleSaved = "toggleSaved",
  saveQuery = "saveQuery",
  restartQueryHost = "restartQueryHost",
  appearanceSystem = "appearanceSystem",
  appearanceLight = "appearanceLight",
  appearanceDark = "appearanceDark",
  selectRows = "selectRows",
  describeTable = "describeTable",
  copyQualifiedName = "copyQualifiedName",
  reloadOwner = "reloadOwner",
  copyCell = "copyCell",
  copyRow = "copyRow",
  copyColumn = "copyColumn",
  copySelectionTsv = "copySelectionTsv",
  copySelectionJson = "copySelectionJson",
  inspectValue = "inspectValue"
}
