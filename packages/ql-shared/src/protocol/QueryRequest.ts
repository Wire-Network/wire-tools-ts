import { z } from "zod"

import { match, P } from "ts-pattern"

import {
  JsonRPCIdSchema,
  JsonRPCVersionSchema,
  SchemaCodec,
  type JsonRPCId
} from "@wireio/cluster-tool-shared"

import { QueryEngineMethod, QueryEngineRPC } from "./QueryEngineRPC.js"

/** An integral request value within the engine's exactly-representable bound. */
const RequestIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(QueryEngineRPC.MaxRequestInteger)

/** `query.execute` params — exactly the engine schema's members (strict: unknown keys are rejected server-side too). */
export const QueryRequestParamsSchema = z.strictObject({
  /** The single SELECT to run. */
  query: z.string().min(1),
  /** Max rows in this page (min'd with any SQL LIMIT; still capped by query-max-result-rows). */
  limit: RequestIntegerSchema.optional(),
  /** Rows skipped after complete evaluation and ordering. */
  offset: RequestIntegerSchema.optional(),
  /** Server deadline in ms; may only LOWER query-timeout-ms (1 … configured). */
  timeout_ms: RequestIntegerSchema.min(
    QueryEngineRPC.MinRequestTimeoutMs
  ).optional()
})

/** `query.execute` params. */
export type QueryRequestParams = z.infer<typeof QueryRequestParamsSchema>

/** Message of an id outside the engine's bounds. */
const IdOutOfBoundsMessage =
  `id must be a string of at most ${QueryEngineRPC.MaxStringIdLength} characters, ` +
  `an integer within ±${QueryEngineRPC.MaxIntegerId}, or null`

/**
 * Whether a JSON-RPC id is within the engine's bounds.
 *
 * @param id - The id.
 * @returns True for a short-enough string, a bounded integer, or null.
 */
function isEngineId(id: JsonRPCId): boolean {
  return match(id)
    .with(P.string, text => text.length <= QueryEngineRPC.MaxStringIdLength)
    .with(
      P.number,
      value =>
        Number.isInteger(value) && Math.abs(value) <= QueryEngineRPC.MaxIntegerId
    )
    .otherwise(() => true)
}

/**
 * JSON-RPC id accepted by the engine — the shared {@link JsonRPCIdSchema}
 * narrowed to the engine bounds: string ≤ 128 chars, integer in ±4294967295, or null.
 */
export const QueryRequestIdSchema = JsonRPCIdSchema.refine(isEngineId, {
  message: IdOutOfBoundsMessage
})

/** A JSON-RPC id accepted by the engine. */
export type QueryRequestId = z.infer<typeof QueryRequestIdSchema>

/**
 * `query.execute` request. `id` is OPTIONAL to match the schema
 * (`required: [jsonrpc, method, params]`); this client always sends one — a
 * request without an id is a notification (HTTP 204, no result).
 */
export const QueryRequestSchema = z.strictObject({
  jsonrpc: JsonRPCVersionSchema,
  id: QueryRequestIdSchema.optional(),
  method: z.literal(QueryEngineMethod["query.execute"]),
  params: QueryRequestParamsSchema
})

/** A `query.execute` request. */
export type QueryRequest = z.infer<typeof QueryRequestSchema>

/** Validating codec for {@link QueryRequestSchema}. */
export const QueryRequestCodec = SchemaCodec.create<QueryRequest>(
  QueryRequestSchema
)
