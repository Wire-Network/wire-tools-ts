import { EventEmitter } from "eventemitter3"

import type { ClosedReason, StreamTopic } from "@wireio/debugging-shared"

/**
 * Event surface for a subscription. Identity-mapped string enum so listener
 * keys read the same on the wire and in code.
 */
export enum DebuggingSubscriptionEventName {
  Event = "event",
  Closed = "closed"
}

/**
 * Typed event map enforced by `eventemitter3` at compile time. Listeners
 * for `event` receive the topic-specific payload `T`; listeners for
 * `closed` receive a typed reason from `@wireio/debugging-shared`.
 *
 * Keys are spelled as string literals (rather than computed from
 * `DebuggingSubscriptionEventName`) so consumers can use either the
 * literal or the enum interchangeably without TypeScript fighting them.
 */
export interface DebuggingSubscriptionEvents<T> {
  event: (payload: T) => void
  closed: (reason: ClosedReason) => void
}

/**
 * Single, transport-agnostic subscription handle. Both
 * `LocalFileDebuggingClient` and `NetDebuggingClient` return instances of
 * this exact class so consumers (TUI services, future tools) treat
 * subscriptions identically regardless of transport.
 *
 * Implementations register an `onClose` thunk that the subscription invokes
 * when the consumer calls `close()`. This gives the transport a clean teardown
 * hook without exposing transport details on the subscription surface.
 */
export class DebuggingSubscription<T> extends EventEmitter<
  DebuggingSubscriptionEvents<T>
> {
  /**
   * Whether `close()` has been invoked or the transport already pushed a
   * `closed` event. Idempotent — subsequent calls are no-ops.
   */
  private closed = false

  /**
   * Buffer for `event` payloads pushed by the transport before the
   * consumer has had a chance to attach a listener. Without this, the
   * race between `await subscribe(...)` returning and the next
   * `sub.on("event", ...)` call meant the first hydration events
   * (which can arrive on the same tick as `Subscribed`) were silently
   * dropped — `EventEmitter3` ignores `emit` to a listenerless event.
   *
   * Drained the moment a listener is attached.
   */
  private pendingEvents: T[] = []

  /**
   * Closed-reason captured before any `closed` listener was attached.
   * Surfaces only when the transport pushes a `Closed` frame in the
   * same tick window as the Subscribed/listener attach race.
   */
  private pendingCloseReason: ClosedReason | null = null

  /**
   * @param id Subscription id allocated by the consumer. Used by the WS
   *           transport to route server-pushed events to the right
   *           subscription instance.
   * @param topic The stream topic this subscription belongs to.
   * @param onCloseInternal Transport-supplied teardown hook; invoked exactly once
   *                from `close()`.
   */
  constructor(
    readonly id: number,
    readonly topic: StreamTopic,
    private readonly onCloseInternal: (reason: ClosedReason) => void
  ) {
    super()
  }

  /** Emit a payload to every listener. Called by transports, not consumers. */
  emitEvent(payload: T): void {
    if (this.closed) return
    if (this.listenerCount(DebuggingSubscriptionEventName.Event) === 0) {
      this.pendingEvents.push(payload)
      return
    }
    this.emit(DebuggingSubscriptionEventName.Event, payload)
  }

  /**
   * Mark the subscription closed and notify listeners. Idempotent — no-op on
   * a closed subscription. Called by transports when the server pushes a
   * `Closed` frame, OR when `close()` is invoked from the consumer.
   */
  notifyClosed(reason: ClosedReason): void {
    if (this.closed) return
    this.closed = true
    if (this.listenerCount(DebuggingSubscriptionEventName.Closed) === 0) {
      this.pendingCloseReason = reason
    } else {
      this.emit(DebuggingSubscriptionEventName.Closed, reason)
    }
    // Listeners may be re-registered later (e.g. async consumer); keep
    // them attached so any pending events that were queued before close
    // can still drain when their listener finally arrives.
  }

  /**
   * Cancel the subscription. Invokes the transport's teardown hook (which
   * sends an `Unsubscribe` frame on a WS transport, or stops a polling
   * timer on the local transport) and emits `closed`.
   */
  close(reason: ClosedReason): void {
    if (this.closed) return
    this.onCloseInternal(reason)
    this.notifyClosed(reason)
  }

  /** Whether the subscription is no longer accepting events. */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Override `on` to drain any events buffered before the listener was
   * attached. Drains on the next tick so the consumer's call site
   * (`subscription.on("event", handler)`) finishes synchronously before
   * the first replayed event fires — preserving the contract that
   * listeners receive events strictly after registration.
   */
  override on(
    event: keyof DebuggingSubscriptionEvents<T>,
    fn: (...args: any[]) => void,
    context?: any
  ): this {
    // eventemitter3's typed `on` overloads collapse on a union key, so we
    // call through `super` with a relaxed cast — runtime behavior is
    // identical to the typed version.
    ;(super.on as any)(event, fn, context)
    if (
      event === DebuggingSubscriptionEventName.Event &&
      this.pendingEvents.length > 0
    ) {
      const drain = this.pendingEvents
      this.pendingEvents = []
      setImmediate(() =>
        drain.forEach(p => this.emit(DebuggingSubscriptionEventName.Event, p))
      )
    }
    if (
      event === DebuggingSubscriptionEventName.Closed &&
      this.pendingCloseReason !== null
    ) {
      const reason = this.pendingCloseReason
      this.pendingCloseReason = null
      setImmediate(() =>
        this.emit(DebuggingSubscriptionEventName.Closed, reason)
      )
    }
    return this
  }
}
