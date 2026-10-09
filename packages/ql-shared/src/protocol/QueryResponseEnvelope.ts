import { z } from "zod"

import { JsonRPCVersionSchema, SchemaCodec } from "@wireio/cluster-tool-shared"

import { QueryEngineErrorSchema } from "./QueryErrorData.js"
import { QueryRequestIdSchema } from "./QueryRequest.js"
import { QueryResultSchema } from "./QueryResult.js"

/** Success envelope — exactly `{ jsonrpc, id, result }`. */
export const QueryResponseSuccessEnvelopeSchema = z.strictObject({
  jsonrpc: JsonRPCVersionSchema,
  id: QueryRequestIdSchema,
  result: QueryResultSchema
})

/** Error envelope — exactly `{ jsonrpc, id, error }`. */
export const QueryResponseErrorEnvelopeSchema = z.strictObject({
  jsonrpc: JsonRPCVersionSchema,
  id: QueryRequestIdSchema,
  error: QueryEngineErrorSchema
})

/** A `query.execute` response — one of the two strict variants (mirrors the schema's `oneOf`). */
export const QueryResponseEnvelopeSchema = z.union([
  QueryResponseSuccessEnvelopeSchema,
  QueryResponseErrorEnvelopeSchema
])

/** A successful `query.execute` response. */
export type QueryResponseSuccessEnvelope = z.infer<
  typeof QueryResponseSuccessEnvelopeSchema
>
/** A failed `query.execute` response. */
export type QueryResponseErrorEnvelope = z.infer<
  typeof QueryResponseErrorEnvelopeSchema
>
/** A parsed `query.execute` response. */
export type QueryResponseEnvelope = z.infer<typeof QueryResponseEnvelopeSchema>

/** Validating codec — a body matching neither variant fails decode (the client raises QueryTransportError). */
export const QueryResponseEnvelopeCodec =
  SchemaCodec.create<QueryResponseEnvelope>(QueryResponseEnvelopeSchema)
