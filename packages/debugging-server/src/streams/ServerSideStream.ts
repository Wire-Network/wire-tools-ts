/**
 * Server-side stream contract. Each stream topic ships an implementation
 * that conforms to this interface; the {@link StreamServer} drives the
 * lifecycle and pipes emitted payloads into WS `EventFrame`s.
 *
 * `start()` is `async` because some streams (envelope-watch) have to do
 * filesystem setup before the first event can fire. `stop()` must be
 * idempotent — `StreamServer` may invoke it on connection close even if
 * the stream already self-terminated.
 */
export interface ServerSideStream<T> {
  /** Begin emitting events. The `emit` callback is owned by `StreamServer`. */
  start(emit: (payload: T) => void): Promise<void>
  /** Tear down timers, watchers, and any held resources. */
  stop(): Promise<void>
}
