/** Main → renderer event channels (identity enum). */
export enum IPCEventChannel {
  /** A menu item / accelerator fired; payload is the AppAction. */
  menuAction = "menuAction",
  /** Carries the query-host MessagePort in `event.ports` (forwarded into the main world by the preload). */
  queryPort = "queryPort",
  /** The query host exited unexpectedly; request a new port. */
  queryHostExited = "queryHostExited",
  /** The query host crash-looped; only Restart recovers. */
  queryHostFailed = "queryHostFailed",
  /** A store file changed on disk (another wql / GUI instance) → reload. */
  storeChanged = "storeChanged"
}
