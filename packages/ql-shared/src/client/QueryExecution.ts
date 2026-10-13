import type { QueryResult } from "../protocol/index.js"
import type { QueryFailure } from "./QueryFailure.js"

/** Outcome discriminator of {@link QueryExecution}. */
export enum QueryExecutionStatus {
  success = "success",
  failure = "failure"
}

/** Fields common to every execution outcome. */
export interface QueryExecutionBase {
  /** JSON-RPC id of the request (shared by its retries). */
  requestId: string
  /** The SQL text. */
  query: string
  /** Client wall time (ms) incl. retries — compare with result.stats.elapsed_us. */
  wallTimeMs: number
  /** Attempts made (1 + auto-retries). */
  attempts: number
}

/** A successful execution carrying the engine result. */
export interface QueryExecutionSuccess extends QueryExecutionBase {
  /** Discriminator. */
  status: QueryExecutionStatus.success
  /** The engine result (one page). */
  result: QueryResult
}

/** Failure class of an execution. */
export enum QueryFailureKind {
  engine = "engine",
  transport = "transport",
  cancelled = "cancelled"
}

/** A failed execution carrying a serializable {@link QueryFailure}. */
export interface QueryExecutionFailure extends QueryExecutionBase {
  /** Discriminator. */
  status: QueryExecutionStatus.failure
  /** What went wrong. */
  failure: QueryFailure
}

/** Discriminated execution outcome (`status`). */
export type QueryExecution = QueryExecutionSuccess | QueryExecutionFailure
