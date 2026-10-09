import { defaults, isEqual } from "lodash"
import { match } from "ts-pattern"

import type { MessageEvent, MessagePortMain, ParentPort } from "electron"
import {
  QueryEngineClient,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryFailure,
  PageSizeMode,
  SchemaCatalog,
  type CatalogSnapshot,
  type ConnectionProfile,
  type ExecuteOptions,
  type QueryExecution
} from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import {
  HostControlKind,
  QueryHostMessageKind,
  type HostControlMessage,
  type QueryHostCancel,
  type QueryHostDescribe,
  type QueryHostExecute,
  type QueryHostLoadOwner,
  type QueryHostRequest,
  type QueryHostResponse
} from "../common/index.js"

const log = getLogger(__filename)

/** The per-profile engine services the host caches. */
export interface QueryHostServices {
  /** The profile these were built for (rebuilt when the incoming profile differs). */
  profile: ConnectionProfile
  /** Engine client (Node fetch — the transport `wql` uses). */
  client: QueryEngineClient
  /** Catalog over the same client. */
  catalog: SchemaCatalog
}

/** Host options (all optional; tests inject a stub fetch). */
export interface QueryHostContextOptions {
  /** Fetch implementation for every engine client. */
  fetchProvider?: typeof fetch
}

/** Resolved host options. */
export interface QueryHostContextConfig extends Required<QueryHostContextOptions> {}

/** In-flight requests of ONE attached port (aborted together on detach). */
export type QueryHostRequestControllers = Map<string, AbortController>

/**
 * Defaults for {@link QueryHostContextOptions}.
 *
 * @returns The default options.
 */
export function createQueryHostContextDefaultOptions(): Partial<QueryHostContextOptions> {
  return { fetchProvider: globalThis.fetch.bind(globalThis) }
}

/**
 * Process-wide host state: one {@link QueryHostServices} per profile name, rebuilt
 * whenever the incoming profile differs from the cached one (an edited endpoint,
 * timeout or owner list takes effect on the next request).
 */
export class QueryHostContext {
  /** Resolved options. */
  readonly config: QueryHostContextConfig
  private readonly services = new Map<string, QueryHostServices>()

  /**
   * @param options - Fetch override.
   */
  constructor(options: QueryHostContextOptions = {}) {
    this.config = defaults({ ...options }, createQueryHostContextDefaultOptions()) as QueryHostContextConfig
  }

  /**
   * The services for `profile` (cached by name; rebuilt when the profile changed).
   *
   * @param profile - The request's connection.
   * @returns The services.
   */
  servicesFor(profile: ConnectionProfile): QueryHostServices {
    const cached = this.services.get(profile.name)
    if (cached != null && isEqual(cached.profile, profile)) return cached
    const client = new QueryEngineClient(profile, { fetchProvider: this.config.fetchProvider }),
      created: QueryHostServices = { profile, client, catalog: new SchemaCatalog(profile, client) }
    this.services.set(profile.name, created)
    return created
  }
}

/**
 * Serve one request. A plain function (no Electron) so it is unit-tested with a
 * stub fetch; `cancel` aborts and answers nothing (its execute answers `cancelled`).
 *
 * @param context - Host state.
 * @param controllers - The calling port's in-flight requests.
 * @param request - The request.
 * @returns The response, or undefined for `cancel`.
 */
export function handleQueryHostRequest(
  context: QueryHostContext,
  controllers: QueryHostRequestControllers,
  request: QueryHostRequest
): Promise<QueryHostResponse> {
  return match(request)
    .with({ kind: QueryHostMessageKind.execute }, execute => runExecute(context, controllers, execute))
    .with({ kind: QueryHostMessageKind.cancel }, cancel => runCancel(controllers, cancel))
    .with({ kind: QueryHostMessageKind.describe }, describe => runDescribe(context, controllers, describe))
    .with({ kind: QueryHostMessageKind.loadOwner }, loadOwner => runLoadOwner(context, controllers, loadOwner))
    .exhaustive()
}

/**
 * Execute one window; a SCHEMA_CHANGED failure drops the cached catalog.
 *
 * @param context - Host state.
 * @param controllers - The port's in-flight requests.
 * @param request - The execute request.
 * @returns The `executed` response.
 */
async function runExecute(
  context: QueryHostContext,
  controllers: QueryHostRequestControllers,
  request: QueryHostExecute
): Promise<QueryHostResponse> {
  const { client, catalog } = context.servicesFor(request.profile),
    options: ExecuteOptions =
      request.mode === PageSizeMode.all ? {} : { limit: request.window.limit, offset: request.window.offset }
  const execution: QueryExecution = await withController(controllers, request.requestId, signal =>
    client.execute(request.query, { ...options, signal })
  )
  if (
    execution.status === QueryExecutionStatus.failure &&
    execution.failure.data?.kind === QueryErrorKind.SCHEMA_CHANGED
  ) {
    catalog.invalidate()
  }
  return { kind: QueryHostMessageKind.executed, requestId: request.requestId, execution }
}

/**
 * Abort one in-flight request of this port (unknown ids are a no-op).
 *
 * @param controllers - The port's in-flight requests.
 * @param request - The cancel request.
 * @returns Nothing to answer.
 */
async function runCancel(
  controllers: QueryHostRequestControllers,
  request: QueryHostCancel
): Promise<QueryHostResponse> {
  controllers.get(request.requestId)?.abort()
  return undefined
}

/**
 * LIMIT 0 describe of a table into the catalog.
 *
 * @param context - Host state.
 * @param controllers - The port's in-flight requests.
 * @param request - The describe request.
 * @returns `described`, or `failed`.
 */
function runDescribe(
  context: QueryHostContext,
  controllers: QueryHostRequestControllers,
  request: QueryHostDescribe
): Promise<QueryHostResponse> {
  const { catalog } = context.servicesFor(request.profile)
  return catalogResponse(request.requestId, QueryHostMessageKind.described, () =>
    withController(controllers, request.requestId, signal =>
      catalog.describe(request.owner, request.table, { signal })
    )
  )
}

/**
 * `get_abi` of one owner into the catalog.
 *
 * @param context - Host state.
 * @param controllers - The port's in-flight requests.
 * @param request - The loadOwner request.
 * @returns `catalog`, or `failed`.
 */
function runLoadOwner(
  context: QueryHostContext,
  controllers: QueryHostRequestControllers,
  request: QueryHostLoadOwner
): Promise<QueryHostResponse> {
  const { catalog } = context.servicesFor(request.profile)
  return catalogResponse(request.requestId, QueryHostMessageKind.catalog, () =>
    withController(controllers, request.requestId, signal => catalog.loadOwner(request.owner, { signal }))
  )
}

/**
 * Run a catalog operation and answer with its snapshot, or a `failed` response
 * carrying the error's classified failure (`QueryFailure.of`: an engine failure
 * keeps its kind, code and retryability; an abort is `cancelled`) — logged,
 * never swallowed.
 *
 * @param requestId - Correlation id.
 * @param kind - The success response kind.
 * @param operation - The catalog call.
 * @returns The response.
 */
async function catalogResponse(
  requestId: string,
  kind: QueryHostMessageKind.described | QueryHostMessageKind.catalog,
  operation: () => Promise<CatalogSnapshot>
): Promise<QueryHostResponse> {
  try {
    const snapshot = await operation()
    return { kind, requestId, snapshot }
  } catch (error) {
    log.warn(`[${requestId}] ${kind} request failed: ${NestedError.toError(error).message}`, error)
    return { kind: QueryHostMessageKind.failed, requestId, failure: QueryFailure.of(error) }
  }
}

/**
 * Register an AbortController for `requestId` while `operation` runs.
 *
 * @param controllers - The port's in-flight requests.
 * @param requestId - Correlation id.
 * @param operation - Receives the controller's signal.
 * @returns The operation's result.
 */
async function withController<T>(
  controllers: QueryHostRequestControllers,
  requestId: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  controllers.set(requestId, controller)
  try {
    return await operation(controller.signal)
  } finally {
    controllers.delete(requestId)
  }
}

/** One attached window port and its in-flight requests. */
interface AttachedPort {
  port: MessagePortMain
  controllers: QueryHostRequestControllers
}

/**
 * The query host's port server: main attaches one MessagePort per window over
 * `parentPort` (`attach` transfers it, `detach` closes it after aborting that
 * port's in-flight requests). Requests are answered on the port they came from.
 */
export class QueryHost {
  private readonly ports = new Map<number, AttachedPort>()

  /**
   * @param parentPort - The utility process's channel to main.
   * @param context - Host state.
   */
  constructor(
    readonly parentPort: ParentPort,
    readonly context: QueryHostContext = new QueryHostContext()
  ) {
    parentPort.on("message", event => this.onControl(event))
  }

  /** Window ids with an attached port. */
  get attachedWindowIds(): number[] {
    return [...this.ports.keys()]
  }

  /**
   * Handle one control message from main.
   *
   * @param event - `{ data: HostControlMessage, ports }`.
   */
  private onControl(event: MessageEvent): void {
    const control = event.data as HostControlMessage
    match(control.kind)
      .with(HostControlKind.attach, () => this.attach(control.windowId, event.ports[0]))
      .with(HostControlKind.detach, () => this.detach(control.windowId))
      .exhaustive()
  }

  /**
   * Serve a newly transferred port.
   *
   * @param windowId - Owning window.
   * @param port - The transferred port1.
   */
  private attach(windowId: number, port: MessagePortMain): void {
    const attached: AttachedPort = { port, controllers: new Map() }
    this.ports.set(windowId, attached)
    port.on("message", event => this.onRequest(attached, event.data as QueryHostRequest))
    port.start()
    log.info(`attached query port for window ${windowId}`)
  }

  /**
   * Abort the window's in-flight requests and close its port (unknown ids are a no-op).
   *
   * @param windowId - Owning window.
   */
  private detach(windowId: number): void {
    const attached = this.ports.get(windowId)
    if (attached == null) return
    attached.controllers.forEach(controller => controller.abort())
    attached.port.close()
    this.ports.delete(windowId)
    log.info(`detached query port for window ${windowId}`)
  }

  /**
   * Answer one request on its own port.
   *
   * @param attached - The port it arrived on.
   * @param request - The request.
   */
  private onRequest(attached: AttachedPort, request: QueryHostRequest): void {
    handleQueryHostRequest(this.context, attached.controllers, request)
      .then(response => {
        if (response != null) attached.port.postMessage(response)
      })
      .catch(error => {
        log.error(`[${request.requestId}] ${request.kind} request crashed: ${NestedError.toError(error).message}`, error)
        attached.port.postMessage({
          kind: QueryHostMessageKind.failed,
          requestId: request.requestId,
          failure: QueryFailure.of(error)
        })
      })
  }
}
