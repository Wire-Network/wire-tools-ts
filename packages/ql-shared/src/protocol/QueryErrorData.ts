import { z } from "zod"

import { QueryErrorCode, QueryErrorKind } from "./QueryErrorKind.js"

/** `error.data` of a failed `query.execute` (1-based positions; enums first-class). */
export const QueryErrorDataSchema = z.strictObject({
  kind: z.enum(QueryErrorKind),
  retryable: z.boolean(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  limit: z.string().nullable()
})

/** `error.data` of a failed `query.execute`. */
export type QueryErrorData = z.infer<typeof QueryErrorDataSchema>

/** The engine's JSON-RPC `error` member — strict (schema `error` and `error.data` are additionalProperties:false). */
export const QueryEngineErrorSchema = z.strictObject({
  code: z.enum(QueryErrorCode),
  message: z.string(),
  data: QueryErrorDataSchema
})

/** The engine's JSON-RPC `error` member. */
export type QueryEngineErrorBody = z.infer<typeof QueryEngineErrorSchema>
