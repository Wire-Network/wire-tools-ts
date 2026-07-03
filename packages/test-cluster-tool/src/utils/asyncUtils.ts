import { Deferred, getLogger } from "@wireio/shared"

const log = getLogger("asyncUtils")

/** Per-probe HTTP fetch timeout used by {@link waitForEndpoint} (ms). */
const FetchProbeTimeoutMs = 2_000

/**
 * HTTP status codes that prove the server is answering — regardless of whether
 * THIS path/method is handled. Removing a code may cause false negatives;
 * adding one may signal "ready" prematurely.
 */
const LivenessStatusCodes = new Set<number>([400, 404, 405])

/** Default give-up window for {@link waitForEndpoint} (ms). */
const DefaultEndpointTimeoutMs = 30_000
/** Default poll gap for {@link waitForEndpoint} (ms). */
const DefaultEndpointIntervalMs = 500
/** Default total attempts for {@link retry} (includes the first try). */
const DefaultRetryAttempts = 3
/** Default gap between {@link retry} attempts (ms). */
const DefaultRetryDelayMs = 1_000

/**
 * Sleep for `ms` milliseconds.
 *
 * @param ms - Duration to wait.
 */
/**
 * Sequentially map `items` through an async `mapper` — the native,
 * AsyncLocalStorage-SAFE replacement for `Bluebird.mapSeries`. Bluebird
 * drains its shared callback queue under whichever async context scheduled
 * the drain, so Bluebird continuations nested inside another Bluebird chain
 * (e.g. a step runner inside the phase executor) DETACH from the step's
 * `StepExtraRecorder` scope and their client calls vanish from the report.
 * Anything that can run under a step scope iterates through THIS.
 *
 * @param items - The inputs, processed strictly in order.
 * @param mapper - Async transform (receives the item + its index).
 * @returns The mapped results, in input order.
 */
export async function mapSeries<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R> | R
): Promise<R[]> {
  return items.reduce(
    async (chain, item, index) => {
      const results = await chain
      results.push(await mapper(item, index))
      return results
    },
    Promise.resolve([] as R[])
  )
}

/**
 * Sequentially run `fn` for each item (result discarded) — the native,
 * AsyncLocalStorage-safe replacement for `Bluebird.each`; see
 * {@link mapSeries} for why Bluebird cannot be used under a step scope.
 *
 * @param items - The inputs, processed strictly in order.
 * @param fn - Async effect (receives the item + its index).
 */
export async function eachSeries<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<unknown> | unknown
): Promise<void> {
  await mapSeries(items, fn)
}

export function sleep(ms: number): Promise<void> {
  return Deferred.delay(ms)
}

/**
 * Single liveness probe — true if the endpoint answers, false if unreachable.
 *
 * Resolves `true` on 2xx **or** on 400/404/405 (the server is answering HTTP
 * even though this URL is not a valid GET). Unreachable / pre-ready (connection
 * refused, DNS, timeout) is `false` — that boolean IS the result, not a
 * swallowed error.
 *
 * @param url - Fully-qualified URL to probe.
 * @returns Whether the endpoint is answering.
 */
export async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(FetchProbeTimeoutMs)
    })
    return LivenessStatusCodes.has(resp.status) || resp.ok
  } catch {
    return false
  }
}

/** Options for {@link waitForEndpoint}. */
export interface WaitForEndpointOptions {
  /** Give up after this many ms. Default 30_000. */
  timeoutMs?: number
  /** Gap between polls (ms). Default 500. */
  intervalMs?: number
  /** Human-readable label for log lines. Default: the URL. */
  label?: string
}

/**
 * Poll an HTTP endpoint (via {@link probeEndpoint}) until it answers, or throw
 * on timeout.
 *
 * @param url - Fully-qualified URL to poll.
 * @param options - Timeout, interval, and label overrides.
 * @throws If the endpoint never becomes ready before the timeout.
 * @example
 *   await waitForEndpoint(`${rpcUrl}/v1/chain/get_info`, { label: "nodeop" })
 */
export async function waitForEndpoint(
  url: string,
  options: WaitForEndpointOptions = {}
): Promise<void> {
  const {
    timeoutMs = DefaultEndpointTimeoutMs,
    intervalMs = DefaultEndpointIntervalMs,
    label = url
  } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeEndpoint(url)) {
      log.info(`${label} is ready`)
      return
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`)
}

/** Options for {@link retry}. */
export interface RetryOptions {
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number
  /** Delay between attempts (ms). Default 1_000. */
  delayMs?: number
  /** Human-readable label used in warn logs. Default "operation". */
  label?: string
  /**
   * Result check — `true` means the thrown error IS the definitive result
   * (rethrown immediately, no retry); `false` means it is transient noise and
   * the operation retries. Default: `() => false` (every error retries).
   * Compose with lodash `negate` to retry one failure class:
   * `checkResult: negate(isTransportFailure)`.
   */
  checkResult?: (error: unknown) => boolean
}

/**
 * Retry an async operation with fixed-interval backoff.
 *
 * @param fn - The async operation to attempt.
 * @param options - Attempt count, delay, and label overrides.
 * @returns The value of `fn` on its first successful attempt.
 * @throws The last error raised by `fn` when every attempt fails.
 * @example
 *   await retry(() => client.call(method, params), { maxAttempts: 5, label: method })
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = DefaultRetryAttempts,
    delayMs = DefaultRetryDelayMs,
    label = "operation",
    checkResult = () => false
  } = options

  const attempt = async (n: number): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      log.warn(
        `${label} attempt ${n}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`
      )
      if (n >= maxAttempts || checkResult(err)) throw err
      await sleep(delayMs)
      return attempt(n + 1)
    }
  }

  return attempt(1)
}
