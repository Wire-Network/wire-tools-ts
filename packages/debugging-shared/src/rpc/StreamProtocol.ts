import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { z } from "zod"
import type {
  ProcessLivenessEvent,
  ProcessLivenessStreamParams
} from "../processes/index.js"
import type { LogTailEvent, LogTailParams } from "../logs/index.js"
import type {
  EnvelopeEvent,
  EnvelopeWatchStreamParams
} from "../opp/index.js"

// ---------------------------------------------------------------------------
//  Topics
// ---------------------------------------------------------------------------

/**
 * Closed set of subscription topics carried over the WebSocket transport.
 * Identity-mapped string enum so values are readable in logs and stable
 * across the wire — renaming a member is a breaking protocol change.
 */
export enum StreamTopic {
  ProcessLiveness = "process-liveness",
  LogTail = "log-tail",
  EnvelopeWatch = "envelope-watch"
}

/**
 * Static map of topic → params/event types. The compile-time single source
 * of truth for what a topic accepts and what it emits — both server and
 * client narrow off this interface at the point of subscribe / dispatch.
 */
/** A stream topic's params + event pairing carried by {@link StreamMap}. */
export interface StreamTopicBinding<Params, Event> {
  params: Params
  event: Event
}

export interface StreamMap {
  [StreamTopic.ProcessLiveness]: StreamTopicBinding<
    ProcessLivenessStreamParams,
    ProcessLivenessEvent
  >
  [StreamTopic.LogTail]: StreamTopicBinding<LogTailParams, LogTailEvent>
  [StreamTopic.EnvelopeWatch]: StreamTopicBinding<
    EnvelopeWatchStreamParams,
    EnvelopeEvent
  >
}

/** Extract the params type for a given topic. */
export type InferredStreamParams<T extends StreamTopic> = StreamMap[T]["params"]

/** Extract the event payload type for a given topic. */
export type InferredStreamEvent<T extends StreamTopic> = StreamMap[T]["event"]

// ---------------------------------------------------------------------------
//  Frame discriminators + protocol-level enums
// ---------------------------------------------------------------------------

/**
 * Identity-mapped discriminator for every WebSocket frame the protocol
 * supports. The frame `type` field is checked against this enum first;
 * anything else is treated as an `ErrorFrame` with `Unknown` code.
 */
export enum StreamFrameType {
  Subscribe = "subscribe",
  Subscribed = "subscribed",
  Event = "event",
  Unsubscribe = "unsubscribe",
  Closed = "closed",
  Error = "error"
}

/**
 * Reason a subscription closed. Typed (rather than free-form strings) so
 * client UIs can branch on the cause — e.g. retrying after a transient
 * server-side fault but surfacing a user-visible warning on
 * `UnsupportedTopic`.
 */
export enum ClosedReason {
  ClientRequested = "client-requested",
  ServerShutdown = "server-shutdown",
  UnsupportedTopic = "unsupported-topic",
  InvalidParams = "invalid-params",
  InternalError = "internal-error"
}

/** Protocol-level error codes carried on `ErrorFrame`. Mirrors JSON-RPC convention where applicable. */
export enum StreamErrorCode {
  /** Frame failed to parse as JSON or did not match any known shape. */
  ParseError = "parse-error",
  /** Frame was structurally valid but its `type` is unknown. */
  InvalidFrameType = "invalid-frame-type",
  /** Subscribe frame referenced a topic the server doesn't expose. */
  UnknownTopic = "unknown-topic",
  /** Subscribe frame's params didn't match the topic's params shape. */
  InvalidParams = "invalid-params",
  /** Server failed to start the subscription for an unspecified reason. */
  Internal = "internal-error"
}

// ---------------------------------------------------------------------------
//  Frame types
// ---------------------------------------------------------------------------

/**
 * Subscribe to a topic. `id` is allocated by the client and echoed on every
 * subsequent frame for that subscription so multiplexing routes correctly.
 */
export interface SubscribeFrame<T extends StreamTopic = StreamTopic> {
  type: StreamFrameType.Subscribe
  /** Client-allocated subscription id. */
  id: number
  /** Topic the client wants to subscribe to. */
  topic: T
  /** Topic-specific params; type narrows via `InferredStreamParams<T>`. */
  params: InferredStreamParams<T>
}

/** Server acknowledgment that a subscription is live. */
export interface SubscribedFrame {
  type: StreamFrameType.Subscribed
  /** Echoes the `id` from the matching {@link SubscribeFrame}. */
  id: number
}

/** Server-pushed event for an active subscription. */
export interface EventFrame<T extends StreamTopic = StreamTopic> {
  type: StreamFrameType.Event
  /** Echoes the subscription `id`. */
  id: number
  /** Topic-specific event payload; type narrows via `InferredStreamEvent<T>`. */
  payload: InferredStreamEvent<T>
}

/** Client-initiated cancellation of a subscription. */
export interface UnsubscribeFrame {
  type: StreamFrameType.Unsubscribe
  /** Echoes the subscription `id`. */
  id: number
}

/**
 * Server-initiated subscription teardown. Sent in response to an
 * `Unsubscribe` (with `ClientRequested`), at server shutdown, or on a
 * fault that doesn't warrant a connection-level error.
 */
export interface ClosedFrame {
  type: StreamFrameType.Closed
  /** Echoes the subscription `id`. */
  id: number
  /** Why the subscription closed. */
  reason: ClosedReason
}

/** Connection-level fault — not associated with a specific subscription. */
export interface ErrorFrame {
  type: StreamFrameType.Error
  /** Typed error code for branching. */
  code: StreamErrorCode
  /** Human-readable message; safe to surface in logs. */
  message: string
}

/** Discriminated union over every frame the protocol supports. */
export type StreamFrame =
  | SubscribeFrame<StreamTopic>
  | SubscribedFrame
  | EventFrame<StreamTopic>
  | UnsubscribeFrame
  | ClosedFrame
  | ErrorFrame

// ---------------------------------------------------------------------------
//  Wire validation — StreamFrameSchemaCodec (envelope; payload/params opaque)
// ---------------------------------------------------------------------------

// Each variant validates its hand-rolled ENVELOPE fields; the topic-specific
// `params` / `payload` (some proto-derived) are opaque passthroughs — validated
// by their own path, NEVER re-declared here (never-rewrap-generated-proto-types).
// `topic` stays `z.string()` so an unknown topic reaches the server's graceful
// `UnknownTopic` path instead of being rejected as a malformed frame.
const SubscribeFrameSchema = z.object({
  type: z.literal(StreamFrameType.Subscribe),
  id: z.number(),
  topic: z.string(),
  params: z.unknown()
})
const SubscribedFrameSchema = z.object({
  type: z.literal(StreamFrameType.Subscribed),
  id: z.number()
})
const EventFrameSchema = z.object({
  type: z.literal(StreamFrameType.Event),
  id: z.number(),
  payload: z.unknown()
})
const UnsubscribeFrameSchema = z.object({
  type: z.literal(StreamFrameType.Unsubscribe),
  id: z.number()
})
const ClosedFrameSchema = z.object({
  type: z.literal(StreamFrameType.Closed),
  id: z.number(),
  reason: z.enum(ClosedReason)
})
const ErrorFrameSchema = z.object({
  type: z.literal(StreamFrameType.Error),
  code: z.enum(StreamErrorCode),
  message: z.string()
})

/** Discriminated union over every wire frame — validates the envelope on both ends. */
export const StreamFrameSchema = z.discriminatedUnion("type", [
  SubscribeFrameSchema,
  SubscribedFrameSchema,
  EventFrameSchema,
  UnsubscribeFrameSchema,
  ClosedFrameSchema,
  ErrorFrameSchema
])

/**
 * The {@link SchemaCodec} for a wire {@link StreamFrame} — validated
 * parse/serialize at the WebSocket boundary (replaces the hand-rolled
 * `isStreamFrame` + per-variant guards). The generic frame interfaces above
 * remain the app type model (typed `params`/`payload` per topic); this codec is
 * the boundary validator with `params`/`payload` as opaque passthroughs.
 */
export const StreamFrameSchemaCodec = SchemaCodec.create(StreamFrameSchema)
