import { isEmpty, negate } from "lodash"
import { log } from "./logger.js"
import { Deferred } from "@wireio/shared"
import Fs from "fs"
import { Future } from "@3fv/prelude-ts"

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return Deferred.delay(ms)
}

/**
 * Check if a file or directory exists at the given path.
 *
 * @param path - The path to check for existence.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export function existsAsync(path: string): Promise<boolean> {
  return Future.of(Fs.promises.lstat(path))
    .map(
      stats => stats.isFile() || stats.isDirectory() || stats.isSymbolicLink()
    )
    .toPromise()
}

export function mkdirs(path: string): string {
  Fs.mkdirSync(path, { recursive: true })
  return path
}

/**
 * Poll an HTTP endpoint until it responds with a "server is up" status.
 *
 * Returns successfully on 2xx **or** on 400/404/405 — these indicate the
 * server is answering HTTP but this particular URL is not a valid GET;
 * they still prove liveness, which is what the caller actually wants.
 *
 * @param url      - Fully-qualified URL to poll.
 * @param opts.timeoutMs  - Give up after this many ms. Default: 30_000.
 * @param opts.intervalMs - Gap between polls. Default: 500.
 * @param opts.label      - Human-readable label for log lines. Default: `url`.
 *
 * @example
 * await waitForEndpoint(`http://127.0.0.1:${port}/v1/chain/get_info`, {
 *   label: "nodeop",
 *   timeoutMs: 15_000
 * })
 */
export async function waitForEndpoint(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
  const { timeoutMs = 30_000, intervalMs = 500, label = url } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(FetchProbeTimeoutMs)
      })
      if (isLivenessStatus(resp.status) || resp.ok) {
        log.info(`${label} is ready`)
        return
      }
    } catch {
      // not ready yet
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`)
}

/** Per-probe HTTP fetch timeout used by {@link waitForEndpoint}. */
const FetchProbeTimeoutMs = 2_000

/**
 * HTTP status codes that prove the server is answering — regardless of
 * whether THIS path+method is handled. Used by {@link waitForEndpoint}.
 * Changing the set affects liveness detection: removing a code may cause
 * false-negatives, adding one may cause premature "ready" signals.
 */
const LivenessStatusCodes = new Set<number>([400, 404, 405])

/** True if `status` is in {@link LivenessStatusCodes}. */
function isLivenessStatus(status: number): boolean {
  return LivenessStatusCodes.has(status)
}

/**
 * Retry an async operation with fixed-interval backoff.
 *
 * @param fn                - The async operation to attempt.
 * @param opts.maxAttempts  - Total attempts (includes the first try). Default: 3.
 * @param opts.delayMs      - Delay between attempts. Default: 1_000.
 * @param opts.label        - Human-readable label used in warn logs. Default: "operation".
 * @returns The resolved value of `fn` on the first successful attempt.
 * @throws The last error raised by `fn` when every attempt fails.
 *
 * @example
 * await retry(() => client.call(method, params), { maxAttempts: 5, label: method })
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; delayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1_000, label = "operation" } = opts

  const attempt = async (n: number): Promise<T> => {
    try {
      return await fn()
    } catch (err: any) {
      log.warn(`${label} attempt ${n}/${maxAttempts} failed: ${err.message}`)
      if (n >= maxAttempts) throw err
      await sleep(delayMs)
      return attempt(n + 1)
    }
  }

  return attempt(1)
}

export const isNotEmpty = negate(isEmpty)

export function inRange(
  value: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): boolean {
  return value >= min && value <= max
}
