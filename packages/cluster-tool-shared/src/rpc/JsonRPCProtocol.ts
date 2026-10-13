import { z } from "zod"

import { SchemaCodec } from "../schema/SchemaCodec.js"

/**
 * JSON-RPC 2.0 constants — the ONE spelling shared by every JSON-RPC client and
 * server in the repo (the debugging server/client and the query-engine client).
 */
export namespace JsonRPCProtocol {
  /**
   * The `jsonrpc` member every request and response carries. Peers reject a
   * message whose `jsonrpc` differs, so changing it breaks every peer.
   */
  export const Version = "2.0"

  /** HTTP verb used for every invocation. */
  export const HttpMethod = "POST"

  /** HTTP headers attached to every invocation. */
  export const RequestHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json"
  } as const

  /**
   * The five standard JSON-RPC 2.0 `error.code` values (numeric enum; the wire
   * integer is the value). Server-defined codes (the `-32000 … -32099` range)
   * belong to each server's own enum, which references these for the standard
   * members.
   */
  export enum ErrorCode {
    PARSE_ERROR = -32700,
    INVALID_REQUEST = -32600,
    METHOD_NOT_FOUND = -32601,
    INVALID_PARAMS = -32602,
    INTERNAL_ERROR = -32603
  }
}

/** A JSON-RPC 2.0 id: a number, a string or null. */
export const JsonRPCIdSchema = z.union([z.number(), z.string(), z.null()])

/** A JSON-RPC 2.0 id. */
export type JsonRPCId = z.infer<typeof JsonRPCIdSchema>

/** The `jsonrpc` member: exactly {@link JsonRPCProtocol.Version}. */
export const JsonRPCVersionSchema = z.literal(JsonRPCProtocol.Version)

/**
 * The JSON-RPC 2.0 error member carried on a failed response envelope. `data`
 * is opaque here; a method-specific schema narrows it. Per the spec exactly one
 * of `result` / `error` is populated; the correlation checks (id match) live at
 * the call site.
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
 * `jsonrpc` must be exactly {@link JsonRPCProtocol.Version}.
 */
export const JsonRPCResponseEnvelopeSchema = z.object({
  jsonrpc: JsonRPCVersionSchema,
  id: JsonRPCIdSchema,
  result: z.unknown().optional(),
  error: JsonRPCErrorSchema.optional()
})

/** A parsed JSON-RPC 2.0 response envelope — the shape of {@link JsonRPCResponseEnvelopeSchema}. */
export type JsonRPCResponseEnvelope = z.infer<
  typeof JsonRPCResponseEnvelopeSchema
>

/**
 * The {@link SchemaCodec} for a JSON-RPC 2.0 response envelope — validates the
 * envelope structure (including the protocol version) with `result` left as an
 * opaque passthrough.
 */
export const JsonRPCResponseEnvelopeSchemaCodec =
  SchemaCodec.create<JsonRPCResponseEnvelope>(JsonRPCResponseEnvelopeSchema)
