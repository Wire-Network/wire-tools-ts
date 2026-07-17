import { Deferred } from "@wireio/shared"
import { getLogger } from "../logging/Logger.js"

const log = getLogger(__filename)

/**
 * Keeps the Node.js event loop alive while `wire-cluster-tool run` is parked
 * waiting for Ctrl+C, after every daemon is up and the epoch-advance liveness
 * check has passed. A bare `await new Promise(() => {})` still lets the
 * process exit once every other handle (timers, sockets) drains; arming a
 * repeating, NON-`unref`'d `setInterval` guarantees the event loop stays open
 * until {@link release} is called.
 *
 * Ctrl+C (SIGINT) never resolves {@link wait} directly — `ProcessManager`'s
 * own SIGINT handler runs the graceful daemon teardown and calls
 * `process.exit()`, which ends the process (and this keep-alive with it) as a
 * side effect. {@link release} exists for programmatic/test callers that need
 * to stop parking without exiting the process.
 */
export class ClusterKeepAlive {
  /** Arm a new keep-alive: a non-`unref`'d interval + a pending {@link Deferred}. */
  static create(): ClusterKeepAlive {
    return new ClusterKeepAlive()
  }

  private readonly deferred = new Deferred<void>()
  private timer: ReturnType<typeof setInterval> | null

  private constructor() {
    this.timer = setInterval(() => {}, ClusterKeepAlive.KeepAliveIntervalMs)
  }

  /** Resolves once {@link release} is called — never resolves on its own. */
  wait(): Promise<void> {
    return this.deferred.promise
  }

  /** Idempotent: clear the interval and resolve {@link wait}. */
  release(): void {
    if (this.timer == null) return
    clearInterval(this.timer)
    this.timer = null
    this.deferred.resolveIfUnsettled()
    log.debug("ClusterKeepAlive released")
  }
}

export namespace ClusterKeepAlive {
  /** Interval period for the keep-alive timer (ms) — only its liveness matters, not its cadence. */
  export const KeepAliveIntervalMs = 30_000
}
