import type {
  CatalogSnapshot,
  ConnectionProfile,
  PageSizeMode,
  PageWindow,
  QueryExecution,
  QueryFailure
} from "@wireio/ql-shared"

/** Message kinds on the query port (identity enum). */
export enum QueryHostMessageKind {
  execute = "execute",
  cancel = "cancel",
  describe = "describe",
  loadOwner = "loadOwner",
  testConnection = "testConnection",
  executed = "executed",
  described = "described",
  catalog = "catalog",
  connectionTested = "connectionTested",
  failed = "failed"
}

/** main → host control kinds (parentPort). */
export enum HostControlKind {
  attach = "attach",
  detach = "detach"
}

/** main → host control message (`attach` carries the port in `event.ports[0]`). */
export interface HostControlMessage {
  /** Attach or detach. */
  kind: HostControlKind
  /** The owning BrowserWindow's webContents id. */
  windowId: number
}

/** Run a query (one server window). */
export interface QueryHostExecute {
  /** Discriminator. */
  kind: QueryHostMessageKind.execute
  /** Correlation id (also the cancellation handle). */
  requestId: string
  /** The connection to run against. */
  profile: ConnectionProfile
  /** SQL text. */
  query: string
  /** Server window (ignored when `mode` is `all`). */
  window: PageWindow
  /** Paged window or one unpaged request. */
  mode: PageSizeMode
}

/** Abandon a query (the server keeps working; the reply is dropped). */
export interface QueryHostCancel {
  /** Discriminator. */
  kind: QueryHostMessageKind.cancel
  /** Request to abandon. */
  requestId: string
}

/** LIMIT 0 describe of a table. */
export interface QueryHostDescribe {
  /** Discriminator. */
  kind: QueryHostMessageKind.describe
  /** Correlation id. */
  requestId: string
  /** The connection. */
  profile: ConnectionProfile
  /** Owner account. */
  owner: string
  /** Table name. */
  table: string
}

/** Load an owner's ABI into the catalog. */
export interface QueryHostLoadOwner {
  /** Discriminator. */
  kind: QueryHostMessageKind.loadOwner
  /** Correlation id. */
  requestId: string
  /** The connection. */
  profile: ConnectionProfile
  /** Owner account. */
  owner: string
}

/**
 * Test a (possibly unsaved) profile's connection: the node's `get_info`, then
 * the engine probe — no ABI, no table read.
 */
export interface QueryHostTestConnection {
  /** Discriminator. */
  kind: QueryHostMessageKind.testConnection
  /** Correlation id. */
  requestId: string
  /** The connection to test. */
  profile: ConnectionProfile
}

/** What a passing connection test learned about the node (plain values: they cross the port). */
export interface ConnectionTestResult {
  /** The chain id (hex). */
  chainId: string
  /** The head block number. */
  headBlockNum: number
}

/** Execution outcome. */
export interface QueryHostExecuted {
  /** Discriminator. */
  kind: QueryHostMessageKind.executed
  /** Correlation id. */
  requestId: string
  /** The serializable outcome. */
  execution: QueryExecution
}

/** Describe outcome. */
export interface QueryHostDescribed {
  /** Discriminator. */
  kind: QueryHostMessageKind.described
  /** Correlation id. */
  requestId: string
  /** The catalog after the describe. */
  snapshot: CatalogSnapshot
}

/** Catalog snapshot after loadOwner. */
export interface QueryHostCatalog {
  /** Discriminator. */
  kind: QueryHostMessageKind.catalog
  /** Correlation id. */
  requestId: string
  /** The catalog after the load. */
  snapshot: CatalogSnapshot
}

/** A passing connection test. */
export interface QueryHostConnectionTested {
  /** Discriminator. */
  kind: QueryHostMessageKind.connectionTested
  /** Correlation id. */
  requestId: string
  /** What the test learned. */
  result: ConnectionTestResult
}

/** A describe / loadOwner / testConnection that failed (execute failures ride `executed`). */
export interface QueryHostFailed {
  /** Discriminator. */
  kind: QueryHostMessageKind.failed
  /** Correlation id. */
  requestId: string
  /** Serializable failure. */
  failure: QueryFailure
}

/** Renderer → host. */
export type QueryHostRequest =
  | QueryHostExecute
  | QueryHostCancel
  | QueryHostDescribe
  | QueryHostLoadOwner
  | QueryHostTestConnection

/** Host → renderer. */
export type QueryHostResponse =
  | QueryHostExecuted
  | QueryHostDescribed
  | QueryHostCatalog
  | QueryHostConnectionTested
  | QueryHostFailed

/** The query host's process arguments (main passes them to `utilityProcess.fork`). */
export namespace QueryHostArguments {
  /** argv flag carrying the logs directory (followed by the path). */
  export const LogsPathFlag = "--logs-path"
}
