import { Either } from "@3fv/prelude-ts"
import { WebSocket } from "ws"
import {
  ApiPaths,
  ClosedReason,
  StreamFrameSchemaCodec,
  StreamFrameType,
  StreamTopic,
  type InferredStreamEvent,
  type InferredStreamParams,
  type StreamFrame,
  type SubscribeFrame,
  type UnsubscribeFrame
} from "@wireio/debugging-shared"

import { DebuggingSubscription } from "../subscriptions/index.js"

/**
 * Per-subscription bookkeeping held by {@link WebSocketStreamClient}.
 * Stored in a map keyed by the client-allocated `id` so inbound frames
 * (`Event`, `Closed`) can route to the right consumer subscription.
 */
interface ActiveSubscription<T extends StreamTopic> {
  topic: T
  subscription: DebuggingSubscription<InferredStreamEvent<T>>
  /** Resolves with `true` once the server sends `Subscribed`. */
  ack: Promise<void>
  ackResolve: () => void
  ackReject: (err: Error) => void
}

/**
 * Single-connection WebSocket transport for stream subscriptions. Holds
 * one open WS per `WebSocketStreamClient` instance, multiplexes every
 * topic over it, and routes inbound frames by subscription id.
 *
 * Reconnection is out of scope for v1 — when the server drops the
 * connection, every active subscription receives a `Closed` event with
 * `ServerShutdown` and the consumer is expected to discard the client.
 */
export class WebSocketStreamClient {
  private ws: WebSocket | null = null
  private nextId = WebSocketStreamClient.InitialSubscriptionId
  private readonly subs = new Map<number, ActiveSubscription<StreamTopic>>()

  /**
   * @param baseUrl Server origin like `http://127.0.0.1:9876`. The WS
   *                client appends `ApiPaths.Stream.Path` and swaps the
   *                scheme to `ws(s)`.
   */
  constructor(readonly baseUrl: string) {}

  /**
   * Open the WebSocket. Returns once the underlying socket is `OPEN`
   * (resolves to no value).
   */
  async connect(): Promise<void> {
    if (this.ws) return
    const url = `${this.baseUrl.replace(/^http/, "ws")}${ApiPaths.Stream.Path}`,
      ws = new WebSocket(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    ws.on("message", raw => this.onMessage(raw.toString()))
    ws.on("close", () => this.onClose())
  }

  /**
   * Cleanly close the WebSocket. Each active subscription receives
   * `closed(ServerShutdown)` so consumer cleanup runs even when the
   * client is shutting itself down.
   */
  async disconnect(): Promise<void> {
    this.subs.forEach(sub =>
      sub.subscription.notifyClosed(ClosedReason.ServerShutdown)
    )
    this.subs.clear()
    if (!this.ws) return
    const ws = this.ws
    this.ws = null
    ws.close()
  }

  /**
   * Subscribe to `topic` with the typed `params`. Resolves with the
   * `DebuggingSubscription` once the server has acknowledged with
   * `Subscribed`. Inbound `Event` frames are routed to the subscription's
   * `event` listener; `Closed` and protocol errors fire `closed`.
   */
  async subscribe<T extends StreamTopic>(
    topic: T,
    params: InferredStreamParams<T>
  ): Promise<DebuggingSubscription<InferredStreamEvent<T>>> {
    if (!this.ws) {
      throw new Error("WebSocketStreamClient: connect() before subscribe()")
    }
    const id = this.nextId++,
      sub = new DebuggingSubscription<InferredStreamEvent<T>>(
        id,
        topic,
        reason => this.sendUnsubscribe(id, reason)
      )
    let ackResolve!: () => void, ackReject!: (err: Error) => void
    const ack = new Promise<void>((res, rej) => {
      ackResolve = res
      ackReject = rej
    })
    const record: ActiveSubscription<T> = {
      topic,
      subscription: sub,
      ack,
      ackResolve,
      ackReject
    }
    this.subs.set(id, record as unknown as ActiveSubscription<StreamTopic>)
    const subscribeFrame: SubscribeFrame<T> = {
      type: StreamFrameType.Subscribe,
      id,
      topic,
      params
    }
    this.send(subscribeFrame)
    await ack
    return sub
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  private onMessage(raw: string): void {
    // Parse + validate the wire frame via the codec; a malformed frame is a
    // benign no-op (drop the message), same as the pre-codec guard behavior.
    const frame = Either.try(() =>
      StreamFrameSchemaCodec.deserialize(raw)
    ).getOrElse(null)
    if (frame == null) return
    if (frame.type === StreamFrameType.Subscribed) {
      this.subs.get(frame.id)?.ackResolve()
    } else if (frame.type === StreamFrameType.Event) {
      const rec = this.subs.get(frame.id)
      if (!rec) return
      rec.subscription.emitEvent(frame.payload as never)
    } else if (frame.type === StreamFrameType.Closed) {
      const rec = this.subs.get(frame.id)
      if (!rec) return
      this.subs.delete(frame.id)
      rec.subscription.notifyClosed(frame.reason)
    } else if (frame.type === StreamFrameType.Error) {
      // Protocol-level error — terminate every active subscription with
      // an InternalError reason; the consumer must reconnect.
      this.subs.forEach(rec => {
        rec.ackReject(new Error(frame.message))
        rec.subscription.notifyClosed(ClosedReason.InternalError)
      })
      this.subs.clear()
    }
  }

  private onClose(): void {
    this.subs.forEach(rec =>
      rec.subscription.notifyClosed(ClosedReason.ServerShutdown)
    )
    this.subs.clear()
    this.ws = null
  }

  private sendUnsubscribe(id: number, _reason: ClosedReason): void {
    if (!this.subs.has(id)) return
    this.subs.delete(id)
    const frame: UnsubscribeFrame = {
      type: StreamFrameType.Unsubscribe,
      id
    }
    this.send(frame)
  }

  private send(frame: StreamFrame): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(StreamFrameSchemaCodec.serialize(frame))
  }
}

export namespace WebSocketStreamClient {
  /** Initial subscription id. Monotonic counter; value not load-bearing. */
  export const InitialSubscriptionId = 1
}
