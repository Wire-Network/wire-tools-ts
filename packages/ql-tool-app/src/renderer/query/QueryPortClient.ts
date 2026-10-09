import { match } from "ts-pattern"

import { QueryEngineClient, type CatalogSnapshot, type ConnectionProfile, type QueryExecution } from "@wireio/ql-shared"
import { Deferred, getLogger, NestedError } from "@wireio/shared"

import {
  QueryHostMessageKind,
  type QueryHostExecute,
  type QueryHostRequest,
  type QueryHostResponse,
  type Unsubscribe
} from "../../common/index.js"
import { QueryPortError } from "./QueryPortError.js"
import { QueryPortEventType, type QueryPortLike } from "./QueryPortLike.js"

const log = getLogger(__filename)

/** Connection state of the renderer's query port (identity enum). */
export enum QueryPortStatus {
  /** A port was requested; calls wait for it. */
  connecting = "connecting",
  /** Calls go out immediately. */
  connected = "connected",
  /** The host crash-looped; every call rejects until Restart delivers a new port. */
  failed = "failed"
}

/** The lifecycle hooks the client needs from the preload bridge (injected; tests fake it). */
export interface QueryPortConnector {
  /** Receive each new port (registered BEFORE the first request). */
  onQueryPort(listener: (port: QueryPortLike) => void): Unsubscribe
  /** Ask main for a new port. */
  requestQueryPort(): void
  /** Status-bar Restart (the only crash-counter reset). */
  restartQueryHost(): void
  /** The host exited unexpectedly (it respawns). */
  onQueryHostExited(listener: () => void): Unsubscribe
  /** The host crash-looped. */
  onQueryHostFailed(listener: () => void): Unsubscribe
}

/** An execute call: everything of {@link QueryHostExecute} but the discriminator. */
export type QueryExecuteParams = Omit<QueryHostExecute, "kind">

/** Receives status changes. */
export type QueryPortStatusListener = (status: QueryPortStatus) => void

/** One call awaiting its response. */
interface PendingCall {
  request: QueryHostRequest
  deferred: Deferred<QueryHostResponse>
  /** Whether it went out on the current port (false = queued while connecting). */
  sent: boolean
}

/**
 * The renderer's side of the query port: requestId-correlated `Deferred`s over
 * whatever port main last handed this window. Ports are only ever requested by
 * the renderer; a new port replaces the old one (rejecting what was in flight on
 * it), `queryHostExited` rejects everything and re-requests, `queryHostFailed`
 * rejects everything AND every new call until Restart delivers a port.
 */
export class QueryPortClient {
  private port: QueryPortLike = null
  private currentStatus = QueryPortStatus.connecting
  private readonly pending = new Map<string, PendingCall>()
  private readonly statusListeners = new Set<QueryPortStatusListener>()
  private readonly unsubscribes: Unsubscribe[] = []
  private readonly onMessage = (event: MessageEvent) => this.receive(event.data as QueryHostResponse)

  /**
   * @param connector - Bridge lifecycle hooks.
   */
  constructor(readonly connector: QueryPortConnector) {}

  /** Current status. */
  get status(): QueryPortStatus {
    return this.currentStatus
  }

  /** Calls awaiting a response (sent or queued). */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Register the port receiver FIRST, then the lifecycle events, then request a port.
   *
   * @returns Stops listening and closes the port.
   */
  start(): Unsubscribe {
    this.unsubscribes.push(
      this.connector.onQueryPort(port => this.replacePort(port)),
      this.connector.onQueryHostExited(() => this.hostExited()),
      this.connector.onQueryHostFailed(() => this.hostFailed())
    )
    this.connector.requestQueryPort()
    return () => this.dispose()
  }

  /**
   * Observe status changes.
   *
   * @param listener - Receives each new status.
   * @returns Unsubscribe.
   */
  onStatus(listener: QueryPortStatusListener): Unsubscribe {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /**
   * Run one query window in the host.
   *
   * @param params - Request id, profile, SQL, window and mode.
   * @returns The execution outcome.
   * @throws QueryPortError when the port was lost, the host failed or the call was cancelled before it was sent.
   */
  async execute(params: QueryExecuteParams): Promise<QueryExecution> {
    const response = await this.call({ ...params, kind: QueryHostMessageKind.execute })
    return match(response)
      .with({ kind: QueryHostMessageKind.executed }, executed => executed.execution)
      .otherwise(other => {
        throw QueryPortClient.unexpected(other)
      })
  }

  /**
   * LIMIT 0 describe of a table.
   *
   * @param requestId - Correlation id.
   * @param profile - The connection.
   * @param owner - Owner account.
   * @param table - Table name.
   * @returns The catalog after the describe.
   */
  async describe(requestId: string, profile: ConnectionProfile, owner: string, table: string): Promise<CatalogSnapshot> {
    const response = await this.call({ kind: QueryHostMessageKind.describe, requestId, profile, owner, table })
    return QueryPortClient.snapshotOf(response)
  }

  /**
   * Load an owner's ABI.
   *
   * @param requestId - Correlation id.
   * @param profile - The connection.
   * @param owner - Owner account.
   * @returns The catalog after the load.
   */
  async loadOwner(requestId: string, profile: ConnectionProfile, owner: string): Promise<CatalogSnapshot> {
    const response = await this.call({ kind: QueryHostMessageKind.loadOwner, requestId, profile, owner })
    return QueryPortClient.snapshotOf(response)
  }

  /**
   * Abandon a request ("Stop"). A call still queued (never sent — the port is
   * connecting) is rejected here at once with a cancelled failure and never
   * goes out; a sent call is cancelled in the host (the server keeps working;
   * its reply becomes a cancelled failure). Unknown ids are ignored.
   *
   * @param requestId - The request.
   */
  cancel(requestId: string): void {
    const call = this.pending.get(requestId)
    if (call == null) return
    if (!call.sent) {
      this.pending.delete(requestId)
      call.deferred.reject(new QueryPortError(QueryEngineClient.cancelledFailure()))
      return
    }
    if (this.port != null && this.currentStatus === QueryPortStatus.connected) {
      this.port.postMessage({ kind: QueryHostMessageKind.cancel, requestId })
    }
  }

  /**
   * A new port arrived: reject what was in flight on the old one ("query host
   * restarted"), close it, bind the new one and flush queued calls. The ONLY way out of `failed`.
   *
   * @param port - The new port.
   */
  replacePort(port: QueryPortLike): void {
    this.rejectWhere(call => call.sent, QueryPortError.HostRestarted)
    if (this.port != null) {
      this.port.removeEventListener(QueryPortEventType.message, this.onMessage)
      this.port.close()
    }
    this.port = port
    port.addEventListener(QueryPortEventType.message, this.onMessage)
    port.start()
    this.setStatus(QueryPortStatus.connected)
    this.pending.forEach(call => this.send(call))
  }

  /** The host exited: reject everything, request a new port (calls made meanwhile wait). */
  hostExited(): void {
    this.rejectWhere(() => true, QueryPortError.HostExited)
    this.dropPort()
    this.setStatus(QueryPortStatus.connecting)
    this.connector.requestQueryPort()
  }

  /** The host crash-looped: reject everything (queued included) and every new call until Restart. */
  hostFailed(): void {
    this.rejectWhere(() => true, QueryPortError.HostFailed)
    this.dropPort()
    this.setStatus(QueryPortStatus.failed)
  }

  /** Status-bar Restart: reset main's crash counter, then request a port. */
  restart(): void {
    this.connector.restartQueryHost()
    this.setStatus(QueryPortStatus.connecting)
    this.connector.requestQueryPort()
  }

  /** Stop listening, reject everything, close the port. */
  dispose(): void {
    this.unsubscribes.splice(0).forEach(unsubscribe => unsubscribe())
    this.rejectWhere(() => true, QueryPortError.HostExited)
    this.dropPort()
  }

  /**
   * Send (or queue) one request and await its correlated response.
   *
   * @param request - The request.
   * @returns The response.
   */
  private call(request: QueryHostRequest): Promise<QueryHostResponse> {
    if (this.currentStatus === QueryPortStatus.failed) {
      return Promise.reject(QueryPortError.lost(QueryPortError.HostFailed))
    }
    const call: PendingCall = { request, deferred: new Deferred<QueryHostResponse>(), sent: false }
    this.pending.set(request.requestId, call)
    if (this.currentStatus === QueryPortStatus.connected) this.send(call)
    return call.deferred.promise
  }

  /**
   * Post a pending call on the current port.
   *
   * @param call - The call.
   */
  private send(call: PendingCall): void {
    if (call.sent) return
    call.sent = true
    this.port.postMessage(call.request)
  }

  /**
   * Settle the call a response belongs to (unknown ids — e.g. abandoned — are dropped).
   *
   * @param response - The host's response.
   */
  private receive(response: QueryHostResponse): void {
    const call = this.pending.get(response.requestId)
    if (call == null) {
      log.debug(`dropping response for unknown request ${response.requestId}`)
      return
    }
    this.pending.delete(response.requestId)
    match(response)
      .with({ kind: QueryHostMessageKind.failed }, failed => call.deferred.reject(new QueryPortError(failed.failure)))
      .otherwise(settled => call.deferred.resolve(settled))
  }

  /**
   * Reject (and forget) the pending calls matching `predicate`.
   *
   * @param predicate - Which calls.
   * @param message - The port-loss message (a {@link QueryPortError} constant).
   */
  private rejectWhere(predicate: (call: PendingCall) => boolean, message: string): void {
    ;[...this.pending.entries()]
      .filter(([, call]) => predicate(call))
      .forEach(([requestId, call]) => {
        this.pending.delete(requestId)
        call.deferred.reject(QueryPortError.lost(message))
      })
  }

  /** Unbind and close the current port. */
  private dropPort(): void {
    if (this.port == null) return
    this.port.removeEventListener(QueryPortEventType.message, this.onMessage)
    this.port.close()
    this.port = null
  }

  /**
   * Change status and notify.
   *
   * @param status - The new status.
   */
  private setStatus(status: QueryPortStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    log.info(`query port ${status}`)
    this.statusListeners.forEach(listener => listener(status))
  }
}

/** Client helpers. */
export namespace QueryPortClient {
  /**
   * The snapshot of a catalog response.
   *
   * @param response - `described` or `catalog`.
   * @returns The snapshot.
   */
  export function snapshotOf(response: QueryHostResponse): CatalogSnapshot {
    return match(response)
      .with({ kind: QueryHostMessageKind.described }, described => described.snapshot)
      .with({ kind: QueryHostMessageKind.catalog }, catalog => catalog.snapshot)
      .otherwise(other => {
        throw unexpected(other)
      })
  }

  /**
   * Error for a response of the wrong kind (a protocol bug).
   *
   * @param response - The response.
   * @returns The error.
   */
  export function unexpected(response: QueryHostResponse): NestedError {
    return new NestedError(`unexpected query-host response ${response.kind}`, {
      context: { requestId: response.requestId, kind: response.kind }
    })
  }
}
