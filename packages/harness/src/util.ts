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
 * Poll an HTTP endpoint until it responds (or timeout).
 * Used to wait for anvil, solana-test-validator, nodeop to be ready.
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
        signal: AbortSignal.timeout(2000)
      })
      if (
        resp.ok ||
        resp.status === 400 ||
        resp.status === 404 ||
        resp.status === 405
      ) {
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

/**
 * Retry a function up to `maxAttempts` times with delay between attempts.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; delayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, label = "operation" } = opts
  let lastErr: Error | undefined
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err
      log.warn(`${label} attempt ${i}/${maxAttempts} failed: ${err.message}`)
      if (i < maxAttempts) await sleep(delayMs)
    }
  }
  throw lastErr
}

export const isNotEmpty = negate(isEmpty)

export function inRange(
  value: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): boolean {
  return value >= min && value <= max
}
