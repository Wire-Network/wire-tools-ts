import { useEffect, useRef } from "react"
import { useInput, type Key } from "ink"
import { asOption } from "@3fv/prelude-ts"

/** Callback invoked when a press-count threshold is reached. */
export type MultiKeyHandler = (key: Key) => void

/**
 * Map of press-count threshold → handler.
 *
 * Example — single Esc pops, double Esc opens a modal:
 *   { 1: () => router.pop(), 2: () => openExitModal() }
 */
export type MultiKeyHandlers = Record<number, MultiKeyHandler>

export namespace MultiKeyTrigger {
  /** Default time (ms) to wait after the last matching press before firing. */
  export const DefaultWindowMs = 300
}

/**
 * Pure state machine driving the N-press detection. Exposed so the logic can
 * be unit-tested without a React renderer. The hook below is a thin React
 * wrapper around this.
 */
export interface MultiKeyMachine {
  /** Feed a press event. */
  press(key: Key): void
  /** Cancel any pending timer (call on unmount). */
  cleanup(): void
}

/**
 * Build a press-tracking state machine. Debounces on `windowMs` from the last
 * matching press; when the window elapses, fires the highest-count handler
 * whose threshold was reached.
 *
 * @param handlers threshold → callback map
 * @param windowMs debounce window (ms); default {@link MultiKeyTrigger.DefaultWindowMs}
 * @param setTimer
 * @param clearTimer
 */
export function createMultiKeyMachine(
  handlers: MultiKeyHandlers,
  windowMs: number = MultiKeyTrigger.DefaultWindowMs,
  setTimer: (cb: () => void, ms: number) => NodeJS.Timeout = setTimeout,
  clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout
): MultiKeyMachine {
  let count = 0,
    timer: NodeJS.Timeout = null,
    lastKey: Key = null
  return {
    press(key: Key): void {
      count += 1
      lastKey = key

      clearTimer(timer)

      timer = setTimer(() => {
        const hit = count,
          latest = lastKey

        count = 0
        lastKey = null
        timer = null

        asOption(latest).map(latest =>
          asOption(
            Object.keys(handlers)
              .map(Number)
              .filter(n => n <= hit)
              .sort((a, b) => b - a)[0]
          ).ifSome(threshold => {
            handlers[threshold](latest)
          })
        )
      }, windowMs)
    },
    cleanup(): void {
      if (timer !== null) clearTimer(timer)
      timer = null
    }
  }
}

/**
 * Detect N-press hotkeys. After each matching press, a timer starts (or is
 * reset). When the timer elapses with no further matching presses, the
 * handler for the HIGHEST reached count fires — sub-thresholds do NOT also
 * fire. This cleanly separates single-tap from double-tap (and beyond)
 * behavior.
 *
 * @param matcher Predicate deciding whether a press contributes to the count.
 * @param handlers Map keyed by press-count threshold.
 * @param windowMs Debounce window; defaults to `MultiKeyTrigger.DefaultWindowMs`.
 *
 * @example
 *   useMultiKeyTrigger(
 *     (_, key) => key.escape,
 *     {
 *       1: () => router.pop(),
 *       2: () => openExitModal()
 *     }
 *   )
 */
export function useMultiKeyTrigger(
  matcher: (input: string, key: Key) => boolean,
  handlers: MultiKeyHandlers,
  windowMs: number = MultiKeyTrigger.DefaultWindowMs
): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const machineRef = useRef<MultiKeyMachine>(null)
  if (machineRef.current === null) {
    machineRef.current = createMultiKeyMachine(
      // Indirect through ref so React-identity changes to `handlers` take effect
      // without rebuilding the machine.
      new Proxy({} as MultiKeyHandlers, {
        get: (_, k) => handlersRef.current[Number(k)]
      }),
      windowMs
    )
  }
  useInput((input, key) => {
    if (!matcher(input, key)) return
    machineRef.current!.press(key)
  })
  useEffect(() => {
    return () => machineRef.current?.cleanup()
  }, [])
}
