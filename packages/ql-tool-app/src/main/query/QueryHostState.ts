/** {@link QueryHostLauncher} states (identity enum). */
export enum QueryHostState {
  /** Constructed, not started: port requests are queued for the first host. */
  idle = "idle",
  /** Fork issued, waiting for the child's `spawn` event. */
  spawning = "spawning",
  /** Child spawned; control messages are posted immediately. */
  ready = "ready",
  /** Unexpected exit; respawn timer armed. */
  backoff = "backoff",
  /** Crash-loop cap reached; only `restartQueryHost` leaves it. */
  failed = "failed",
  /** App quitting; never respawns. */
  disposed = "disposed"
}

/** {@link QueryHostLauncher} inputs (identity enum; the transition table is keyed by these). */
export enum QueryHostEvent {
  startRequested = "startRequested",
  spawned = "spawned",
  exited = "exited",
  backoffElapsed = "backoffElapsed",
  portRequested = "portRequested",
  windowClosed = "windowClosed",
  restartRequested = "restartRequested",
  beforeQuit = "beforeQuit"
}
