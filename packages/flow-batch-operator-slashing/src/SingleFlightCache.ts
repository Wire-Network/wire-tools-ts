/**
 * A per-key single-flight promise cache: concurrent `get`s for the same key share ONE in-flight
 * `fetch`, and a resolved value is retained so later `get`s reuse it without re-fetching.
 *
 * The dedupe is race-free because the pending promise is registered SYNCHRONOUSLY — between the
 * `Map.get` miss and the `Map.set`, only `fetch()` (up to its first `await`) runs, with no `await`
 * in {@link get} itself — so two callers that both miss cannot each start a fetch. This is exactly
 * the property the slashing flow needs: every parallel `deliver` for one `(chain_code, epoch)` must
 * chain from the SAME pre-delivery tip, even though a peer delivery may advance that tip inline the
 * moment consensus is reached.
 *
 * A REJECTED fetch is evicted rather than cached, so a transient read failure does not poison the
 * key — a subsequent `get` re-attempts the fetch. Resolved values are never evicted (the tip for a
 * settled `(chain_code, epoch)` is immutable for the life of the flow), so this is a memoizing
 * cache, not merely an in-flight de-duplicator.
 *
 * @typeParam K - The cache key type.
 * @typeParam V - The resolved value type.
 */
export class SingleFlightCache<K, V> {
  /** In-flight or resolved promises by key; a key is present iff a fetch is running or has succeeded. */
  private readonly entries = new Map<K, Promise<V>>()

  /**
   * Return the shared promise for `key`, starting `fetch` only if no promise is already registered.
   *
   * @param key - The cache key.
   * @param fetch - Produces the value on a miss. Invoked at most once per successful key; re-invoked
   *   on a later `get` only if a prior attempt rejected.
   * @returns The shared (possibly in-flight) promise for `key`.
   */
  get(key: K, fetch: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      return existing
    }
    // Evict on rejection so a transient failure does not permanently poison the key. The `.catch`
    // runs after the synchronous `set` below, so eviction cannot race the registration.
    const pending = fetch().catch(error => {
      this.entries.delete(key)
      throw error
    })
    this.entries.set(key, pending)
    return pending
  }
}
