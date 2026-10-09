import { Either } from "@3fv/prelude-ts"

import { SchemaCodec } from "../schema/SchemaCodec.js"
import { JsonRPCProtocol, type JsonRPCId } from "./JsonRPCProtocol.js"
import {
  JsonRPCTransportError,
  JsonRPCTransportStage
} from "./JsonRPCTransportError.js"

/** A JSON-RPC 2.0 request envelope (`params` typed by the method). */
export interface JsonRPCRequestEnvelope<Params = unknown> {
  /** Exactly {@link JsonRPCProtocol.Version}. */
  jsonrpc: typeof JsonRPCProtocol.Version
  /**
   * The correlation id the response must echo. Optional only to admit the
   * schema-inferred shapes (`strictNullChecks` is off); a call always sets it —
   * an id-less request is a notification and answers no envelope.
   */
  id?: JsonRPCId
  /** The method name. */
  method: string
  /** The method's params. */
  params: Params
}

/** The member every decoded response envelope carries for correlation. */
export interface JsonRPCIdentifiedEnvelope {
  /** The echoed request id (optional only to admit schema-inferred shapes). */
  id?: JsonRPCId
}

/**
 * The JSON-RPC 2.0 HTTP pipeline shared by every client in the repo (the
 * debugging client and the query-engine client): POST the envelope → require a
 * 2xx with a body → parse the JSON ONCE → validate it with the response codec →
 * require the echoed id. It returns the decoded envelope; branching on a
 * `result` vs an `error` member, and mapping {@link JsonRPCTransportError}
 * stages onto a client's own errors, stay with each client.
 */
export namespace JsonRPCTransport {
  /** HTTP 204 — a JSON-RPC notification's answer; a call expecting a response treats it as a failure. */
  export const NoContentStatus = 204

  /** Writes a request envelope as the POST body. A validating {@link SchemaCodec} satisfies it. */
  export interface RequestSerializer<RequestEnvelope> {
    /**
     * @param request - The envelope.
     * @returns The JSON text.
     */
    serialize(request: RequestEnvelope): string
  }

  /** One invocation. */
  export interface Invocation<
    RequestEnvelope extends JsonRPCRequestEnvelope,
    ResponseEnvelope extends JsonRPCIdentifiedEnvelope
  > {
    /** Fully-qualified endpoint URL. */
    url: string
    /** The request envelope. */
    request: RequestEnvelope
    /** Serializes the request (a serializer throw is a caller bug — it propagates unwrapped). */
    requestSerializer: RequestSerializer<RequestEnvelope>
    /** Validates + decodes the parsed response body. */
    responseCodec: SchemaCodec<ResponseEnvelope>
    /** The fetch implementation (called unbound). */
    fetchProvider: typeof fetch
    /** Cancellation (caller abort and/or a client deadline). */
    signal?: AbortSignal
  }

  /**
   * Run one invocation.
   *
   * @param invocation - URL, envelope, serializer, response codec, fetch and signal.
   * @returns The decoded response envelope (its id equals the request's).
   * @throws JsonRPCTransportError naming the failing {@link JsonRPCTransportStage}.
   */
  export async function invoke<
    RequestEnvelope extends JsonRPCRequestEnvelope,
    ResponseEnvelope extends JsonRPCIdentifiedEnvelope
  >(
    invocation: Invocation<RequestEnvelope, ResponseEnvelope>
  ): Promise<ResponseEnvelope> {
    const {
        url,
        request,
        requestSerializer,
        responseCodec,
        fetchProvider,
        signal
      } = invocation,
      body = requestSerializer.serialize(request),
      failure = (
        stage: JsonRPCTransportStage,
        message: string,
        status: number,
        cause?: unknown,
        parsed: unknown = null
      ) =>
        new JsonRPCTransportError(message, {
          stage,
          url,
          status,
          requestId: request.id,
          body: parsed,
          cause
        })

    let response: Response
    try {
      response = await fetchProvider(url, {
        method: JsonRPCProtocol.HttpMethod,
        headers: JsonRPCProtocol.RequestHeaders,
        body,
        signal
      })
    } catch (error) {
      throw failure(
        JsonRPCTransportStage.request,
        `request to ${url} failed`,
        null,
        error
      )
    }
    const { status, statusText } = response
    if (!response.ok || status === NoContentStatus) {
      throw failure(
        JsonRPCTransportStage.status,
        `HTTP ${status} ${statusText}`.trim(),
        status
      )
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw failure(
        JsonRPCTransportStage.read,
        "reading the response failed",
        status,
        error
      )
    }
    const parsed = Either.try(() => JSON.parse(text) as unknown)
        .ifLeft(error => {
          throw failure(
            JsonRPCTransportStage.decode,
            "the response body is not JSON",
            status,
            error
          )
        })
        .getOrThrow(),
      envelope = responseCodec
        .validate(parsed)
        .ifLeft(error => {
          throw failure(
            JsonRPCTransportStage.decode,
            `invalid JSON-RPC response envelope — ${SchemaCodec.formatIssues(error)}`,
            status,
            error,
            parsed
          )
        })
        .getOrThrow()
    if (envelope.id !== request.id) {
      throw failure(
        JsonRPCTransportStage.id,
        `JSON-RPC id mismatch: expected ${String(request.id)}, got ${String(envelope.id)}`,
        status
      )
    }
    return envelope
  }
}
