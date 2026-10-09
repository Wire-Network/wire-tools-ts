import { match } from "ts-pattern"
import { z } from "zod"

import { SchemaCodec } from "@wireio/cluster-tool-shared"

import {
  QueryExecutionStatus,
  QueryFailureKind,
  type QueryExecution
} from "../client/QueryExecution.js"
import { QueryErrorKind } from "../protocol/index.js"
import { QueryOutcome } from "./QueryOutcome.js"

/** One `history.jsonl` record. */
export const QueryHistoryEntrySchema = z.strictObject({
  /** The request id of the execution. */
  id: z.string().min(1),
  /** Profile name (or endpoint for ad-hoc connections). */
  profile: z.string(),
  /** The SQL text. */
  query: z.string(),
  /** ISO-8601 execution time. */
  executedAt: z.iso.datetime(),
  /** How it ended. */
  outcome: z.enum(QueryOutcome),
  /** Engine error kind for `engineError`, else null. */
  errorKind: z.enum(QueryErrorKind).nullable(),
  /** Rows returned for `success`, else null. */
  returnedRows: z.number().int().min(0).nullable(),
  /** Client wall time (ms). */
  wallTimeMs: z.number().min(0)
})

/** One history record. */
export type QueryHistoryEntry = z.infer<typeof QueryHistoryEntrySchema>

/** Codec for {@link QueryHistoryEntrySchema}. */
export const QueryHistoryEntryCodec = SchemaCodec.create<QueryHistoryEntry>(
  QueryHistoryEntrySchema
)

/** History-record derivation. */
export namespace QueryHistoryEntry {
  /**
   * The {@link QueryOutcome} of an execution — exhaustive over the status and
   * the failure class. (It lives here rather than on `QueryOutcome` because a
   * namespace merged into an enum adds its functions to `Object.values`, which
   * `z.enum(QueryOutcome)` would then accept.)
   *
   * @param execution - The execution.
   * @returns success / engineError / transportError / cancelled.
   */
  export function outcomeOf(execution: QueryExecution): QueryOutcome {
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, () => QueryOutcome.success)
      .with({ status: QueryExecutionStatus.failure }, failed =>
        match(failed.failure.kind)
          .with(QueryFailureKind.engine, () => QueryOutcome.engineError)
          .with(QueryFailureKind.transport, () => QueryOutcome.transportError)
          .with(QueryFailureKind.cancelled, () => QueryOutcome.cancelled)
          .exhaustive()
      )
      .exhaustive()
  }

  /**
   * The history record of one execution — the ONE execution → record mapping
   * every surface (CLI, TUI, GUI) appends.
   *
   * @param execution - The outcome.
   * @param profileName - Profile it ran against (or the endpoint of an ad-hoc connection).
   * @param at - Execution time.
   * @returns The record.
   */
  export function of(execution: QueryExecution, profileName: string, at: Date): QueryHistoryEntry {
    const base = {
      id: execution.requestId,
      profile: profileName,
      query: execution.query,
      executedAt: at.toISOString(),
      outcome: outcomeOf(execution),
      wallTimeMs: execution.wallTimeMs
    }
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, success => ({
        ...base,
        errorKind: null,
        returnedRows: Number(success.result.page.returned_rows)
      }))
      .with({ status: QueryExecutionStatus.failure }, failed => ({
        ...base,
        errorKind: failed.failure.data?.kind ?? null,
        returnedRows: null
      }))
      .exhaustive()
  }
}
