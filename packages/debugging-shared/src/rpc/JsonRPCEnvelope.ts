import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { z } from "zod"

/**
 * The JSON-RPC 2.0 error member carried on a failed response envelope. Per the
 * spec exactly one of `result` / `error` is populated; the correlation checks
 * (version, id match) live at the call site.
 */
export const JsonRPCErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional()
})

/**
 * A parsed JSON-RPC 2.0 response envelope. The `result` payload is an opaque
 * passthrough — its per-method shape (protobuf or plain JSON) is validated by
 * its own path, NEVER re-declared here (never-rewrap-generated-proto-types).
 */
export const JsonRPCResponseEnvelopeSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: JsonRPCErrorSchema.optional()
})

/** A parsed JSON-RPC 2.0 response envelope — the shape of {@link JsonRPCResponseEnvelopeSchema}. */
export type JsonRPCResponseEnvelope = z.infer<
  typeof JsonRPCResponseEnvelopeSchema
>

/**
 * The {@link SchemaCodec} for a JSON-RPC 2.0 response envelope — validates the
 * envelope structure (replaces the client's hand-rolled `as ResponseEnvelope`
 * cast) with `result` left as an opaque passthrough.
 */
export const JsonRPCResponseEnvelopeSchemaCodec =
  SchemaCodec.create<JsonRPCResponseEnvelope>(JsonRPCResponseEnvelopeSchema)
