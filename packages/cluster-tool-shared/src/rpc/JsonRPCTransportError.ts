import { NestedError } from "@wireio/shared"

import type { JsonRPCId } from "./JsonRPCProtocol.js"

/** Where a {@link JsonRPCTransport.invoke} pipeline failed (identity enum). */
export enum JsonRPCTransportStage {
  /** The fetch itself rejected (network failure, abort, timeout). */
  request = "request",
  /** A non-2xx status, or `204 No Content` (a JSON-RPC call always answers with a body). */
  status = "status",
  /** Reading the response body failed. */
  read = "read",
  /** The body is not JSON, or not a valid envelope for the response codec. */
  decode = "decode",
  /** The envelope's `id` differs from the request's. */
  id = "id"
}

/** Construction input for {@link JsonRPCTransportError}. */
export interface JsonRPCTransportErrorInit {
  /** The failing stage. */
  stage: JsonRPCTransportStage
  /** The endpoint URL that was called. */
  url: string
  /** HTTP status, or null when no response arrived. */
  status: number
  /** The request's JSON-RPC id. */
  requestId: JsonRPCId
  /**
   * The parsed JSON body of a `decode` failure whose body WAS valid JSON (for
   * client-specific probing, e.g. a schema version), else null.
   */
  body: unknown
  /** The originating error, when wrapping one. */
  cause?: unknown
}

/**
 * A JSON-RPC transport/envelope failure — never a server `error` member (that
 * is a decoded envelope, branched on by each client). Each client maps the
 * {@link stage} onto its own error type.
 */
export class JsonRPCTransportError extends NestedError {
  /** The failing stage. */
  readonly stage: JsonRPCTransportStage
  /** The endpoint URL that was called. */
  readonly url: string
  /** HTTP status, or null when no response arrived. */
  readonly status: number
  /** The request's JSON-RPC id. */
  readonly requestId: JsonRPCId
  /** The parsed body of a `decode` failure over valid JSON, else null. */
  readonly body: unknown
  /** What failed, without the folded context (the constructor's message). */
  readonly detail: string

  /**
   * @param message - What failed.
   * @param init - Stage, URL, status, request id, parsed body and an optional cause.
   */
  constructor(message: string, init: JsonRPCTransportErrorInit) {
    const { stage, url, status, requestId, body, cause } = init
    super(message, { cause, context: { stage, url, status, requestId } })
    this.name = "JsonRPCTransportError"
    this.stage = stage
    this.url = url
    this.status = status
    this.requestId = requestId
    this.body = body
    this.detail = message
  }
}
