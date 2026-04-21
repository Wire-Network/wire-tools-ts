import { IMessageType } from "@protobuf-ts/runtime"
import type { Router, Request, Response, NextFunction } from "express"

import {
  DebuggingDefaults,
  FROM_JSON_OPTIONS,
  HandlerURIType,
  HandlerTypeMappings,
  InferredHandlerType,
  TO_JSON_OPTIONS
} from "@wire-e2e-tests/debugging-shared"
import { isObject } from "@wireio/shared"
import { log } from "./logging"
import { Future } from "@3fv/prelude-ts"
import { match, P } from "ts-pattern"
import { identity } from "lodash"

export namespace JsonRPC {
  /** JSON-RPC 2.0 error codes */
  export enum ErrorCode {
    PARSE_ERROR = -32700,
    INVALID_REQUEST = -32600,
    METHOD_NOT_FOUND = -32601,
    INVALID_PARAMS = -32602,
    INTERNAL_ERROR = -32603
  }

  /**
   * Handler registry — maps method names (the API path strings from
   * HandlerMap, e.g. "/api/opp/envelope") to their handler functions.
   */
  export type HandlerRegistry<
    Req extends IMessageType<any> = IMessageType<any>,
    Res extends IMessageType<any> = IMessageType<any>
  > = Map<
    string,
    (reqMessage: Req, req: Request, res: Response) => Promise<Res>
  >

  /**
   * Register a strongly-typed handler in the registry.
   * Types are inferred from the HandlerMap at compile time.
   */
  export function addRoute<
    U extends HandlerURIType,
    H extends InferredHandlerType<U> = InferredHandlerType<U>
  >(registry: HandlerRegistry, method: U, handler: H): void {
    registry.set(method, handler as any)
  }

  /**
   * Check if a parsed JSON body is a JSON-RPC 2.0 request.
   */
  function isJsonRPC(body: any): boolean {
    return (
      body &&
      typeof body === "object" &&
      body.jsonrpc === DebuggingDefaults.JsonrpcVersion
    )
  }

  /**
   * Send JSON response with BigInt support.
   * BigInt values are converted to Number for JSON serialization.
   */
  function sendJson(res: Response, status: number, data: any): void {
    res
      .status(status)
      .setHeader("Content-Type", "application/json")
      .end(JSON.stringify(prepareForJson(data)))
  }

  /** Deep-convert BigInts to Numbers and Buffers/Uint8Arrays to base64 strings */
  function prepareForJson(value: any): any {
    return match(value)
      .with(null, undefined, identity)
      .with(P.bigint, v => Number(v))
      .with(P.instanceOf(Buffer), v => Buffer.from(v).toString("base64"))
      .when(Array.isArray, v => v.map(prepareForJson))
      .when(isObject, value =>
        Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, prepareForJson(v)])
        )
      )
      .otherwise(identity)
  }

  /**
   * Mount a POST endpoint that auto-detects JSON-RPC 2.0 vs plain JSON.
   *
   * - **JSON-RPC 2.0**: Body has `"jsonrpc":"2.0"` — `method` field selects
   *   the handler, `params` is passed as the body, response wrapped in
   *   `{"jsonrpc":"2.0","result":...,"id":N}`.
   *
   * - **Plain JSON**: Body is unwrapped — the handler method is determined
   *   from the request URL path, body is passed directly.
   *
   * All handlers in the registry are also mounted as individual POST routes
   * for plain JSON access (e.g. POST /api/opp/envelope with plain body).
   */
  export function mount(
    router: Router,
    basePath: string,
    registry: HandlerRegistry
  ): void {
    // JSON-RPC dispatch endpoint — POST to basePath
    router.post(
      basePath,
      async (req: Request, res: Response, _next: NextFunction) => {
        const body = req.body

        if (!isJsonRPC(body)) {
          return res
            .status(400)
            .json({ error: "Expected JSON-RPC 2.0 request at this endpoint" })
        }

        await dispatchJsonRPC(body, registry, req, res)
      }
    )

    // Individual plain-JSON routes for each registered handler
    registry.forEach((handler, method) => {
      router.post(
        method,
        async (req: Request, res: Response, _next: NextFunction) => {
          const body = req.body

          if (isJsonRPC(body)) {
            // JSON-RPC sent to an individual route — still handle it
            await dispatchJsonRPC(body, registry, req, res)
            return
          }

          // Plain JSON — body IS the params
          try {
            const result = await handler(body, req, res)
            if (!res.headersSent) {
              sendJson(res, 200, result)
            }
          } catch (err: any) {
            if (!res.headersSent) {
              sendJson(res, 500, {
                error: err.message ?? "Unknown error",
                stack: err?.stack ?? "Stack not available"
              })
            }
          }
        }
      )
    })
  }

  async function dispatchJsonRPC(
    body: any,
    registry: HandlerRegistry,
    req: Request,
    res: Response
  ): Promise<void> {
    const id = body.id ?? null

    if (typeof body.method !== "string") {
      sendJson(res, 200, {
        jsonrpc: DebuggingDefaults.JsonrpcVersion,
        error: {
          code: JsonRPC.ErrorCode.INVALID_REQUEST,
          message: "Missing 'method'"
        },
        id
      })
      return
    }

    if (!isObject(body.params)) {
      sendJson(res, 200, {
        jsonrpc: DebuggingDefaults.JsonrpcVersion,
        error: {
          code: JsonRPC.ErrorCode.INVALID_REQUEST,
          message: `Invalid request: ${body.params}`
        },
        id
      })
      return
    }

    const handler = registry.get(body.method)
    if (!handler) {
      sendJson(res, 200, {
        jsonrpc: DebuggingDefaults.JsonrpcVersion,
        error: {
          code: JsonRPC.ErrorCode.METHOD_NOT_FOUND,
          message: `Method not found: ${body.method}`
        },
        id
      })
      return
    }

    try {
      const [reqMessageType, resMessageType] =
          HandlerTypeMappings[body.method as HandlerURIType],
        reqMessage = reqMessageType.fromJson(
          body.params,
          FROM_JSON_OPTIONS
        ) as IMessageType<any>

      // const result = await Future.of(handler(body.params, req, res))
      const result = await Future.of(handler(reqMessage, req, res))
        .map(resMessage => resMessageType.toJson(resMessage, TO_JSON_OPTIONS))
        .toPromise()
      if (!res.headersSent) {
        sendJson(res, 200, {
          jsonrpc: DebuggingDefaults.JsonrpcVersion,
          result,
          id
        })
      }
    } catch (err: any) {
      log.error(`Error handling RPC request: ${err.message}`, {
        method: body.method,
        params: body.params,
        error: err
      })
      if (!res.headersSent) {
        sendJson(res, 200, {
          jsonrpc: DebuggingDefaults.JsonrpcVersion,
          error: {
            code: JsonRPC.ErrorCode.INTERNAL_ERROR,
            message: err.message || "Internal error"
          },
          id
        })
      }
    }
  }
}
