import { MessageType } from "@protobuf-ts/runtime"
import {
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

export const FROM_JSON_OPTIONS = {
    ignoreUnknownFields: true
  } as const,
  TO_JSON_OPTIONS = { enumAsInteger: true, emitDefaultValues: true } as const

export namespace ApiPaths {
  export const Ping = "/api/ping" as const

  export namespace OPP {
    export const Endpoint = "/api/opp" as const
    export const Methods = {
      Envelope: "Envelope",
      EnvelopeList: "EnvelopeList",
      EnvelopeGet: "EnvelopeGet"
    } as const
    export type MethodKey = keyof typeof Methods
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
  [ApiPaths.OPP.Methods.Envelope]: Handler<
    PutEnvelopeRequest,
    PutEnvelopeResponse
  >
  [ApiPaths.OPP.Methods.EnvelopeList]: Handler<
    ListEnvelopesRequest,
    ListEnvelopesResponse
  >
  [ApiPaths.OPP.Methods.EnvelopeGet]: Handler<
    GetEnvelopeRequest,
    GetEnvelopeResponse
  >
}
export type MessageTypeCtor<T extends object = any> = { new (): MessageType<T> }
export const HandlerTypeMappings: {
  [URI in ApiPaths.OPP.MethodKey]: [MessageType<any>, MessageType<any>]
} = {
  [ApiPaths.OPP.Methods.Envelope]: [PutEnvelopeRequest, PutEnvelopeResponse],
  [ApiPaths.OPP.Methods.EnvelopeList]: [
    ListEnvelopesRequest,
    ListEnvelopesResponse
  ],
  [ApiPaths.OPP.Methods.EnvelopeGet]: [GetEnvelopeRequest, GetEnvelopeResponse]
} as const

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

export type JsonRPCResult<T extends {} = any> = {
  status: number
  body: T
  id: number
}
