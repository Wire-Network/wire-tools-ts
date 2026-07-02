/**
 * Resolve after `ms` milliseconds — the async-primitives topic util (the `tail`
 * poll loop's delay lives here, not as a one-function `sleep.ts`).
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that resolves once the delay elapses.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
