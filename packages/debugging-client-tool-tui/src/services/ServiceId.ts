/**
 * Every registered Service's `id`. Use these identifiers in `dependsOn` arrays,
 * `ServiceManager.get<T>(id)` calls, and `useService<T>(id)` hooks — never
 * raw strings. Changing a member value is a breaking change; it must stay in
 * lockstep with every `static readonly id` declaration across service classes.
 */
export enum ServiceId {
  Redux = "redux",
  DebuggingClient = "debugging-client",
  OPPTracking = "opp-tracking",
  ProcessMonitor = "process-monitor",
  LogTailing = "log-tailing"
}
