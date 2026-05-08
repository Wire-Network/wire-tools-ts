import { WebSocket } from "ws"

import {
  ApiPaths,
  StreamFrameType,
  type StreamFrame,
  type StreamTopic,
  type SubscribeFrame,
  type UnsubscribeFrame
} from "@wireio/debugging-shared"

/** Open a WS client connection to the running server's stream endpoint. */
export async function connectStream(baseUrl: string): Promise<WebSocket> {
  const url = `${baseUrl.replace(/^http/, "ws")}${ApiPaths.Stream.Path}`
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })
  return ws
}

/** Send a subscribe frame. */
export function sendSubscribe<T extends StreamTopic>(
  ws: WebSocket,
  frame: SubscribeFrame<T>
): void {
  ws.send(JSON.stringify(frame))
}

/** Send an unsubscribe frame. */
export function sendUnsubscribe(ws: WebSocket, id: number): void {
  const frame: UnsubscribeFrame = {
    type: StreamFrameType.Unsubscribe,
    id
  }
  ws.send(JSON.stringify(frame))
}

/** Collect frames as they arrive; resolve when `predicate` is satisfied. */
export function collectFrames(
  ws: WebSocket,
  count: number,
  timeoutMs = 5_000
): Promise<StreamFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: StreamFrame[] = []
    const onMessage = (data: Buffer) => {
      const parsed = JSON.parse(data.toString()) as StreamFrame
      frames.push(parsed)
      if (frames.length >= count) {
        ws.off("message", onMessage)
        clearTimeout(timer)
        resolve(frames)
      }
    }
    const timer = setTimeout(() => {
      ws.off("message", onMessage)
      reject(
        new Error(
          `Timed out waiting for ${count} frames (got ${frames.length})`
        )
      )
    }, timeoutMs)
    ws.on("message", onMessage)
  })
}
