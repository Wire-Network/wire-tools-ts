import type {
  PutEnvelopeRequest,
  PutEnvelopeResponse,
  ListEnvelopesRequest,
  ListEnvelopesResponse,
  GetEnvelopeRequest,
  GetEnvelopeResponse
} from "@wireio/opp-typescript-models"

// ---------------------------------------------------------------------------
//  API path constants — single source of truth for all URI strings
// ---------------------------------------------------------------------------

export namespace ApiPaths {
  export const Ping = "/api/ping" as const

  export namespace OPP {
    export const Base = "/api/opp" as const
    export const Envelope = "/api/opp/envelope" as const
    export const EnvelopeList = "/api/opp/envelope/list" as const
    export const EnvelopeGet = "/api/opp/envelope/get" as const
  }
}

// ---------------------------------------------------------------------------
//  Core handler abstraction — no express dependency.
//  R = request body type, T = response type.
//  The server narrows the second/third args to express Request/Response;
//  this definition only needs to carry R and T for type inference.
// ---------------------------------------------------------------------------

export type Handler<R = unknown, T = unknown> = (
  body: R,
  ...args: any[]
) => Promise<T> | T

// ---------------------------------------------------------------------------
//  Handler map — pure type definition, no runtime object.
//  The server provides implementations that conform to this interface.
//  The client infers request/response types from it.
// ---------------------------------------------------------------------------

export interface HandlerMap {
  [ApiPaths.OPP.Envelope]: Handler<PutEnvelopeRequest, PutEnvelopeResponse>
  [ApiPaths.OPP.EnvelopeList]: Handler<ListEnvelopesRequest, ListEnvelopesResponse>
  [ApiPaths.OPP.EnvelopeGet]: Handler<GetEnvelopeRequest, GetEnvelopeResponse>
}

// ---------------------------------------------------------------------------
//  Inferred utility types — used by server addRoute(), client, and tests
// ---------------------------------------------------------------------------

export type HandlerURIType = keyof HandlerMap

/** Extract the full handler function type for a given URI */
export type InferredHandlerType<U extends HandlerURIType> = HandlerMap[U]

/** Extract the request body type for a given URI */
export type InferredRequestType<U extends HandlerURIType> =
  HandlerMap[U] extends Handler<infer R, unknown> ? R : never

/** Extract the response type for a given URI */
export type InferredResponseType<U extends HandlerURIType> =
  HandlerMap[U] extends Handler<unknown, infer T> ? T : never
