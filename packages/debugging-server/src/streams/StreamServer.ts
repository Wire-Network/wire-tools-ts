import * as Http from "node:http"

import { Either } from "@3fv/prelude-ts"
import { match } from "ts-pattern"
import { WebSocketServer, type WebSocket } from "ws"
import {
  ApiPaths,
  ClosedReason,
  StreamErrorCode,
  StreamFrameSchemaCodec,
  StreamFrameType,
  StreamTopic,
  type ClosedFrame,
  type ErrorFrame,
  type EventFrame,
  type LogTailParams,
  type StreamFrame,
  type SubscribeFrame,
  type SubscribedFrame,
  type UnsubscribeFrame
} from "@wireio/debugging-shared"

import { log } from "../logging/index.js"
import type { ClusterAccess } from "../services/ClusterAccess.js"

import { EnvelopeWatchStream } from "./EnvelopeWatchStream.js"
import { LogTailStream } from "./LogTailStream.js"
import { ProcessLivenessStream } from "./ProcessLivenessStream.js"
import type { ServerSideStream } from "./ServerSideStream.js"

/**
 * Per-connection record of an active subscription.
 *
 * The `stream` reference stays around even after `stop()` because the
 * stream may need to drain pending emissions on its way out — the
 * server's bookkeeping only cares about the id/connection mapping.
 */
interface ActiveSubscription {
  id: number
  stream: ServerSideStream<unknown>
}

/**
 * WebSocket multiplexer for stream subscriptions. One `WebSocketServer`
 * instance per `DebuggingServer`; consumers connect to
 * `ApiPaths.Stream.Path` and send subscribe/unsubscribe frames.
 *
 * Each connection has its own subscription map keyed by the client-allocated
 * `id`. Connection close tears down every active subscription synchronously.
 */
export class StreamServer {
  private wss: WebSocketServer | null = null
  private readonly subscriptions = new Map<
    WebSocket,
    Map<number, ActiveSubscription>
  >()

  /**
   * @param clusterAccess Drives the `ProcessLiveness` stream's snapshot loop.
   * @param clusterPath   Used by `LogTail` traversal validation and
   *                      `EnvelopeWatch` storage path resolution.
   */
  constructor(
    private readonly clusterAccess: ClusterAccess,
    private readonly clusterPath: string
  ) {}

  /**
   * Attach a `WebSocketServer` to `httpServer` in `noServer` mode and
   * route `upgrade` events on `ApiPaths.Stream.Path`. Should be called
   * after `httpServer.listen()` has bound the port.
   */
  attach(httpServer: Http.Server): void {
    this.wss = new WebSocketServer({ noServer: true })
    httpServer.on("upgrade", (request, socket, head) => {
      if (request.url !== ApiPaths.Stream.Path) {
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(request, socket, head, ws => {
        this.wss!.emit("connection", ws, request)
      })
    })
    this.wss.on("connection", ws => this.onConnection(ws))
  }

  /** Close the WS server and tear down every active subscription. */
  async detach(): Promise<void> {
    const allSubs = [...this.subscriptions.values()].flatMap(perConn => [
      ...perConn.values()
    ])
    await Promise.all(allSubs.map(sub => sub.stream.stop()))
    this.subscriptions.clear()
    this.wss?.clients.forEach(ws => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    })
    this.wss?.close()
    this.wss = null
  }

  // -------------------------------------------------------------------------
  //  Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    this.subscriptions.set(ws, new Map())
    ws.on("message", raw => void this.onMessage(ws, raw.toString()))
    ws.on("close", () => void this.onClose(ws))
    ws.on("error", err => log.warn("WS connection error", err))
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    // Parse + validate the wire frame via the codec (replaces the hand-rolled
    // JSON.parse + isStreamFrame guard); a malformed frame is a ParseError.
    const frame = Either.try(() =>
      StreamFrameSchemaCodec.deserialize(raw)
    ).getOrElse(null)
    if (frame == null) {
      sendError(ws, StreamErrorCode.ParseError, "Frame is not a valid StreamFrame")
      return
    }
    await match(frame)
      .with({ type: StreamFrameType.Subscribe }, async f => {
        await this.handleSubscribe(ws, f as SubscribeFrame<StreamTopic>)
      })
      .with({ type: StreamFrameType.Unsubscribe }, async f => {
        await this.handleUnsubscribe(ws, f as UnsubscribeFrame)
      })
      .otherwise(() => {
        sendError(
          ws,
          StreamErrorCode.InvalidFrameType,
          `Server does not accept frames of type ${frame.type}`
        )
      })
  }

  private async onClose(ws: WebSocket): Promise<void> {
    const perConn = this.subscriptions.get(ws)
    if (!perConn) return
    this.subscriptions.delete(ws)
    await Promise.all([...perConn.values()].map(sub => sub.stream.stop()))
  }

  // -------------------------------------------------------------------------
  //  Subscribe / Unsubscribe
  // -------------------------------------------------------------------------

  private async handleSubscribe(
    ws: WebSocket,
    frame: SubscribeFrame<StreamTopic>
  ): Promise<void> {
    const perConn = this.subscriptions.get(ws)
    if (!perConn) return
    const stream = this.createStream(frame)
    if (!stream) {
      sendError(
        ws,
        StreamErrorCode.UnknownTopic,
        `No such topic: ${frame.topic}`
      )
      return
    }
    // Acknowledge BEFORE starting the stream so the consumer sees
    // `Subscribed` before any baseline `Event` the stream emits during
    // `start()`. Order matters for clients that route by id.
    perConn.set(frame.id, { id: frame.id, stream })
    sendSubscribed(ws, frame.id)
    try {
      await stream.start(payload => sendEvent(ws, frame.id, payload))
    } catch (err: any) {
      perConn.delete(frame.id)
      sendError(
        ws,
        StreamErrorCode.Internal,
        `Subscribe failed: ${err.message ?? err}`
      )
    }
  }

  private async handleUnsubscribe(
    ws: WebSocket,
    frame: UnsubscribeFrame
  ): Promise<void> {
    const perConn = this.subscriptions.get(ws)
    if (!perConn) return
    const sub = perConn.get(frame.id)
    if (!sub) return
    perConn.delete(frame.id)
    await sub.stream.stop()
    sendClosed(ws, frame.id, ClosedReason.ClientRequested)
  }

  // -------------------------------------------------------------------------
  //  Stream factory
  // -------------------------------------------------------------------------

  private createStream(
    frame: SubscribeFrame<StreamTopic>
  ): ServerSideStream<unknown> {
    return match(frame.topic)
      .with(StreamTopic.LogTail, () => {
        const params = frame.params as LogTailParams
        return new LogTailStream(
          params,
          this.clusterPath
        ) as ServerSideStream<unknown>
      })
      .with(
        StreamTopic.ProcessLiveness,
        () =>
          new ProcessLivenessStream(
            this.clusterAccess
          ) as ServerSideStream<unknown>
      )
      .with(
        StreamTopic.EnvelopeWatch,
        () =>
          new EnvelopeWatchStream(this.clusterPath) as ServerSideStream<unknown>
      )
      .otherwise(() => null)
  }
}

// ---------------------------------------------------------------------------
//  Frame senders
// ---------------------------------------------------------------------------

function sendEvent(ws: WebSocket, id: number, payload: unknown): void {
  const frame: EventFrame<StreamTopic> = {
    type: StreamFrameType.Event,
    id,
    payload: payload as never
  }
  safeSend(ws, frame)
}

function sendSubscribed(ws: WebSocket, id: number): void {
  const frame: SubscribedFrame = { type: StreamFrameType.Subscribed, id }
  safeSend(ws, frame)
}

function sendClosed(ws: WebSocket, id: number, reason: ClosedReason): void {
  const frame: ClosedFrame = {
    type: StreamFrameType.Closed,
    id,
    reason
  }
  safeSend(ws, frame)
}

function sendError(
  ws: WebSocket,
  code: StreamErrorCode,
  message: string
): void {
  const frame: ErrorFrame = { type: StreamFrameType.Error, code, message }
  safeSend(ws, frame)
}

/** Best-effort `ws.send` — log + drop on a closed-connection error. */
function safeSend(ws: WebSocket, frame: StreamFrame): void {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(StreamFrameSchemaCodec.serialize(frame))
  } catch (err) {
    log.warn("WS send failed", err)
  }
}
