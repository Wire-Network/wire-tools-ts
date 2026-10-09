/** Renderer → main channels (identity enum): invokes and fire-and-forget sends. */
export enum IPCChannel {
  showOpenDialog = "showOpenDialog",
  showSaveDialog = "showSaveDialog",
  showContextMenu = "showContextMenu",
  setThemeSource = "setThemeSource",
  profilesList = "profilesList",
  profilesUpsert = "profilesUpsert",
  profilesRemove = "profilesRemove",
  profilesSetDefault = "profilesSetDefault",
  historyList = "historyList",
  historyAppend = "historyAppend",
  historyClear = "historyClear",
  savedList = "savedList",
  savedUpsert = "savedUpsert",
  savedRemove = "savedRemove",
  exportWrite = "exportWrite",
  readQueryFile = "readQueryFile",
  writeQueryFile = "writeQueryFile",
  /** Send: a renderer/preload log record for main's file sink. */
  log = "log",
  /** Send: "give me a new query port". */
  requestQueryPort = "requestQueryPort",
  /** Send: status-bar Restart (the ONLY crash-counter reset). */
  restartQueryHost = "restartQueryHost"
}
