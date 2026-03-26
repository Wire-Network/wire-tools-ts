import { isEmpty, negate } from "lodash"
import { log } from "./logger.js"

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
      if (resp.ok || resp.status === 404 || resp.status === 405) {
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
