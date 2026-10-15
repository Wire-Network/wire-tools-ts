import { defaults } from "lodash"
import { match, P } from "ts-pattern"

import {
  app,
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents
} from "electron"
import { getLogger, NestedError } from "@wireio/shared"

import {
  HostControlKind,
  IPCEventChannel,
  QueryHostArguments,
  type HostControlMessage
} from "../../common/index.js"
import { AppPaths } from "../AppPaths.js"
import { QueryHostEvent, QueryHostState } from "./QueryHostState.js"

const log = getLogger(__filename)

/** Launcher options (all optional). */
export interface QueryHostLauncherOptions {
  /** The query-host bundle (default: `query-host.js` next to `main.js`). */
  hostModuleFile?: string
  /** Logs directory handed to the host (default: Electron's logs path). */
  logsPath?: string
}

/** Resolved launcher options. */
export interface QueryHostLauncherConfig extends Required<QueryHostLauncherOptions> {}

/** One queued control message; `attach` carries its untransferred port1. */
interface QueuedControl {
  message: HostControlMessage
  port: MessagePortMain
}

/**
 * Defaults for {@link QueryHostLauncherOptions}.
 *
 * @returns The default options.
 */
export function createQueryHostLauncherDefaultOptions(): Partial<QueryHostLauncherOptions> {
  return {
    hostModuleFile: AppPaths.resolve(__dirname).hostModuleFile,
    logsPath: app.getPath("logs")
  }
}

/**
 * Owns the ONE query-host `utilityProcess` and the per-window MessagePort pairs.
 * An explicit state machine (see {@link QueryHostState} / {@link QueryHostEvent}):
 * it starts `idle` and {@link start} (valid only there) forks the first host;
 * ports are ONLY renderer-requested; one ordered control queue buffers
 * attach/detach while `idle` / `spawning` / `backoff` and is flushed on
 * `spawn` — so a window that asks before `start` is served by the first host,
 * deliberately, instead of being refused; unexpected exits (a fork that throws
 * synchronously included) back off exponentially; more than
 * {@link QueryHostLauncher.MaxRestarts} exits inside
 * {@link QueryHostLauncher.RestartIntervalMs} enter `failed`, which only
 * {@link restartRequested} leaves; `beforeQuit` disposes for good.
 */
export class QueryHostLauncher {
  /** Resolved options. */
  readonly config: QueryHostLauncherConfig
  private currentState = QueryHostState.idle
  private child: UtilityProcess = null
  private backoffTimer: ReturnType<typeof setTimeout> = null
  private readonly queue: QueuedControl[] = []
  /** Windows whose port is attached to the CURRENT host (only while `ready`; an exit clears it). */
  private readonly attached = new Set<number>()
  /** Every window that ever requested a port and is still open. */
  private readonly windows = new Map<number, WebContents>()
  /** Windows awaiting a port while `failed`. */
  private readonly waiting = new Set<number>()
  /** Exit timestamps inside the sliding restart window. */
  private exits: number[] = []

  /**
   * @param options - Host bundle path and logs directory.
   */
  constructor(options: QueryHostLauncherOptions = {}) {
    this.config = defaults({ ...options }, createQueryHostLauncherDefaultOptions()) as QueryHostLauncherConfig
  }

  /** Current state. */
  get state(): QueryHostState {
    return this.currentState
  }

  /** The running child's pid (undefined when none). */
  get pid(): number {
    return this.child?.pid
  }

  /** Window ids recorded as waiting while `failed`. */
  get waitingWindowIds(): number[] {
    return [...this.waiting]
  }

  /** Number of queued control messages. */
  get queuedCount(): number {
    return this.queue.length
  }

  /**
   * Fork the first host (`idle` → `spawning`; queued port requests are served once it spawns).
   *
   * @throws NestedError when the launcher was already started or disposed.
   */
  start(): void {
    this.trace(QueryHostEvent.startRequested)
    if (this.currentState !== QueryHostState.idle) {
      throw new NestedError(`the query host launcher cannot start in ${this.currentState}`, {
        context: { state: this.currentState }
      })
    }
    this.fork()
  }

  /**
   * A window asked for a new query port.
   *
   * @param webContents - The requesting window.
   */
  portRequested(webContents: WebContents): void {
    const windowId = webContents.id
    this.trace(QueryHostEvent.portRequested, windowId)
    match(this.currentState)
      .with(QueryHostState.disposed, () => undefined)
      .with(QueryHostState.failed, () => {
        this.windows.set(windowId, webContents)
        this.waiting.add(windowId)
        QueryHostLauncher.sendToWindow(webContents, IPCEventChannel.queryHostFailed)
      })
      .with(QueryHostState.ready, () => {
        this.windows.set(windowId, webContents)
        const { port1, port2 } = new MessageChannelMain()
        if (this.attached.has(windowId)) this.postControl({ kind: HostControlKind.detach, windowId })
        this.postControl({ kind: HostControlKind.attach, windowId }, port1)
        this.attached.add(windowId)
        QueryHostLauncher.sendPort(webContents, port2)
      })
      .with(P.union(QueryHostState.idle, QueryHostState.spawning, QueryHostState.backoff), () => {
        this.windows.set(windowId, webContents)
        const { port1, port2 } = new MessageChannelMain()
        this.enqueueAttach(windowId, port1)
        QueryHostLauncher.sendPort(webContents, port2)
      })
      .exhaustive()
  }

  /**
   * A window closed (or reloaded away for good): detach its port and forget it.
   *
   * @param windowId - The window's webContents id.
   */
  windowClosed(windowId: number): void {
    this.trace(QueryHostEvent.windowClosed, windowId)
    match(this.currentState)
      .with(QueryHostState.disposed, () => undefined)
      .with(QueryHostState.ready, () => {
        if (this.attached.has(windowId)) this.postControl({ kind: HostControlKind.detach, windowId })
      })
      .with(P.union(QueryHostState.idle, QueryHostState.spawning, QueryHostState.backoff), () => {
        this.dropQueuedAttach(windowId)
      })
      .with(QueryHostState.failed, () => undefined)
      .exhaustive()
    this.attached.delete(windowId)
    this.windows.delete(windowId)
    this.waiting.delete(windowId)
  }

  /** Status-bar Restart: the ONLY way out of `failed` (and the only crash-counter reset). */
  restartRequested(): void {
    this.trace(QueryHostEvent.restartRequested)
    if (this.currentState !== QueryHostState.failed) return
    this.exits = []
    const waiting = [...this.waiting]
    this.waiting.clear()
    this.fork()
    waiting
      .map(windowId => this.windows.get(windowId))
      .filter(webContents => webContents != null && !webContents.isDestroyed())
      .forEach(webContents => this.portRequested(webContents))
  }

  /** App quitting: `disposed` FIRST, then cancel timers and kill the child (its exit is ignored). */
  dispose(): void {
    this.trace(QueryHostEvent.beforeQuit)
    if (this.currentState === QueryHostState.disposed) return
    this.currentState = QueryHostState.disposed
    if (this.backoffTimer != null) clearTimeout(this.backoffTimer)
    this.backoffTimer = null
    this.clearQueue()
    const child = this.child
    this.child = null
    child?.kill()
  }

  /**
   * Fork a host and wire its lifecycle events (→ `spawning`). A fork that throws
   * synchronously is an exit of that (never-spawned) host: it backs off, or
   * enters `failed` past the cap, exactly like a crash.
   */
  private fork(): void {
    this.currentState = QueryHostState.spawning
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(
        this.config.hostModuleFile,
        [QueryHostArguments.LogsPathFlag, this.config.logsPath],
        { serviceName: QueryHostLauncher.ServiceName }
      )
    } catch (error) {
      log.error(`forking the query host ${this.config.hostModuleFile} failed: ${NestedError.toError(error).message}`, error)
      this.child = null
      this.exited(`fork threw ${NestedError.toError(error).message}`)
      return
    }
    this.child = child
    child.once("spawn", () => this.onSpawned(child))
    child.once("exit", code => this.onExited(child, `exit code ${code}`))
    child.once("error", (type, location) => this.onExited(child, `error ${type} at ${location}`))
    log.info(`forked query host ${this.config.hostModuleFile}`)
  }

  /**
   * `spawn`: flush the queue in order (→ `ready`).
   *
   * @param child - The child that spawned (ignored when stale).
   */
  private onSpawned(child: UtilityProcess): void {
    if (child !== this.child || this.currentState !== QueryHostState.spawning) return
    this.trace(QueryHostEvent.spawned)
    this.currentState = QueryHostState.ready
    this.queue.splice(0).forEach(({ message, port }) => {
      this.postControl(message, port)
      if (message.kind === HostControlKind.attach) this.attached.add(message.windowId)
    })
    log.info(`query host ready (pid ${child.pid})`)
  }

  /**
   * Unexpected exit (or fork `error`): back off, or enter `failed` past the cap.
   *
   * @param child - The child that ended (ignored when stale or disposed).
   * @param reason - For the log.
   */
  private onExited(child: UtilityProcess, reason: string): void {
    if (child !== this.child || this.currentState === QueryHostState.disposed) return
    this.child = null
    this.exited(reason)
  }

  /**
   * The current host is gone: count the exit, then back off or enter `failed`.
   *
   * @param reason - For the log.
   */
  private exited(reason: string): void {
    this.trace(QueryHostEvent.exited)
    const now = Date.now()
    this.exits = [...this.exits.filter(at => now - at < QueryHostLauncher.RestartIntervalMs), now]
    const crashes = this.exits.length,
      liveWindows = [...this.windows.values()].filter(webContents => !webContents.isDestroyed())
    this.clearQueue()
    this.attached.clear()
    if (crashes > QueryHostLauncher.MaxRestarts) {
      log.error(`query host ${reason}; ${crashes} exits within ${QueryHostLauncher.RestartIntervalMs}ms — failed`)
      this.currentState = QueryHostState.failed
      liveWindows.forEach(webContents => {
        this.waiting.add(webContents.id)
        QueryHostLauncher.sendToWindow(webContents, IPCEventChannel.queryHostFailed)
      })
      return
    }
    const delayMs = QueryHostLauncher.backoffDelayMs(crashes)
    log.warn(`query host ${reason}; respawning in ${delayMs}ms (exit ${crashes})`)
    this.currentState = QueryHostState.backoff
    liveWindows.forEach(webContents => QueryHostLauncher.sendToWindow(webContents, IPCEventChannel.queryHostExited))
    this.backoffTimer = setTimeout(() => this.onBackoffElapsed(), delayMs)
  }

  /** Backoff timer fired: respawn (→ `spawning`). */
  private onBackoffElapsed(): void {
    this.backoffTimer = null
    if (this.currentState !== QueryHostState.backoff) return
    this.trace(QueryHostEvent.backoffElapsed)
    this.fork()
  }

  /**
   * Queue an attach, superseding this window's queued attach (its untransferred
   * port1 is closed). No window is attached while queueing (`idle`: none ever
   * was; `spawning` / `backoff`: an exit cleared every attachment), so there is
   * never a live port to detach first.
   *
   * @param windowId - The window.
   * @param port - Its new port1.
   */
  private enqueueAttach(windowId: number, port: MessagePortMain): void {
    this.dropQueuedAttach(windowId)
    this.queue.push({ message: { kind: HostControlKind.attach, windowId }, port })
  }

  /**
   * Remove this window's queued attach (closing its untransferred port1).
   *
   * @param windowId - The window.
   * @returns Whether one was queued.
   */
  private dropQueuedAttach(windowId: number): boolean {
    const index = this.queue.findIndex(
      ({ message }) => message.kind === HostControlKind.attach && message.windowId === windowId
    )
    if (index < 0) return false
    const [dropped] = this.queue.splice(index, 1)
    dropped.port?.close()
    return true
  }

  /** Empty the queue, closing every untransferred port1. */
  private clearQueue(): void {
    this.queue.splice(0).forEach(({ port }) => port?.close())
  }

  /**
   * Post one control message to the running host (port1 transferred with `attach`).
   *
   * @param message - attach / detach.
   * @param port - port1 for `attach`.
   */
  private postControl(message: HostControlMessage, port: MessagePortMain = null): void {
    this.child.postMessage(message, port == null ? [] : [port])
  }

  /**
   * Debug trace of a state-machine input.
   *
   * @param event - The input.
   * @param windowId - The window, when the input concerns one.
   */
  private trace(event: QueryHostEvent, windowId?: number): void {
    log.debug(`${event}${windowId == null ? "" : ` (window ${windowId})`} in ${this.currentState}`)
  }
}

/** Launcher tuning + helpers. */
export namespace QueryHostLauncher {
  /** First respawn delay; doubles per consecutive exit. */
  export const BackoffBaseMs = 500
  /** Respawn delay cap. */
  export const BackoffMaxMs = 8_000
  /** Exits tolerated inside {@link RestartIntervalMs}; one more enters `failed`. */
  export const MaxRestarts = 5
  /** Sliding window for the crash-loop count. */
  export const RestartIntervalMs = 60_000
  /** `utilityProcess` service name (visible in `app.getAppMetrics()`). */
  export const ServiceName = "wire-ql-query-host"

  /**
   * Respawn delay after the n-th exit inside the window.
   *
   * @param exitCount - Exits inside the window (≥ 1).
   * @returns `min(BackoffBaseMs·2^(n-1), BackoffMaxMs)`.
   */
  export function backoffDelayMs(exitCount: number): number {
    return Math.min(BackoffBaseMs * 2 ** (exitCount - 1), BackoffMaxMs)
  }

  /**
   * Hand port2 to a window (preload → main world).
   *
   * @param webContents - The window.
   * @param port - port2.
   */
  export function sendPort(webContents: WebContents, port: MessagePortMain): void {
    if (webContents.isDestroyed()) {
      port.close()
      return
    }
    webContents.postMessage(IPCEventChannel.queryPort, null, [port])
  }

  /**
   * Send a payload-less lifecycle event to a live window.
   *
   * @param webContents - The window.
   * @param channel - queryHostExited / queryHostFailed.
   */
  export function sendToWindow(
    webContents: WebContents,
    channel: IPCEventChannel.queryHostExited | IPCEventChannel.queryHostFailed
  ): void {
    if (!webContents.isDestroyed()) webContents.send(channel)
  }
}
