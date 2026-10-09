import { act } from "react"

/** {@link waitFor} ceiling. */
export const WaitForTimeoutMs = 5_000
/** {@link waitFor} poll interval. */
export const WaitForPollMs = 10

/**
 * Poll `condition` (each wait inside act, so React updates flush) until it
 * holds — for fire-and-forget work a key or a file watcher started.
 *
 * @param condition - The condition.
 * @param timeoutMs - Give up after this long.
 * @throws Error when the deadline passes first.
 */
export async function waitFor(condition: () => boolean, timeoutMs = WaitForTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not reached within ${timeoutMs} ms`)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, WaitForPollMs))
    })
  }
}
