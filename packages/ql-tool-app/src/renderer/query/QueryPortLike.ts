import type { QueryHostRequest } from "../../common/index.js"

/** Port event types (identity enum). */
export enum QueryPortEventType {
  message = "message"
}

/**
 * The port surface {@link QueryPortClient} uses — the part shared by the DOM
 * `MessagePort` (renderer) and the `node:worker_threads` `MessagePort` (tests).
 */
export interface QueryPortLike {
  /** Subscribe to messages. */
  addEventListener(type: QueryPortLike.MessageEventType, listener: (event: MessageEvent) => void): void
  /** Unsubscribe. */
  removeEventListener(type: QueryPortLike.MessageEventType, listener: (event: MessageEvent) => void): void
  /** Begin delivery (DOM ports queue until started). */
  start(): void
  /** Send a request to the query host. */
  postMessage(message: QueryHostRequest): void
  /** Close this end. */
  close(): void
}

/** QueryPortLike companion types. */
export namespace QueryPortLike {
  /** The only event type used. */
  export type MessageEventType = `${QueryPortEventType}`
}
