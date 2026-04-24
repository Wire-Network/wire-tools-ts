import {
  createMultiKeyMachine,
  MultiKeyTrigger,
  useMultiKeyTrigger
} from "@wire-e2e-tests/debugging-client-tool-tui/hooks/useMultiKeyTrigger.js"

// Minimal Key shape — ink's type is not resolvable under `module: commonjs`.
// We stub any necessary flag + cast at call-sites.
type Key = Record<string, boolean>

function mkKey(overrides: Partial<Key> = {}): any {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
    super: false,
    hyper: false,
    alt: false,
    fn: false,
    ...overrides
  }
}

/**
 * Manual timer seam — tests control time explicitly. Simpler and more robust
 * than jest.useFakeTimers across our transpile setup.
 */
function manualTimer() {
  const queue = new Map<number, { cb: () => void; dueAt: number }>()
  let now = 0
  let nextId = 1
  return {
    setTimer(cb: () => void, ms: number): number {
      const id = nextId++
      queue.set(id, { cb, dueAt: now + ms })
      return id
    },
    clearTimer(t: unknown): void {
      queue.delete(t as number)
    },
    advance(ms: number): void {
      now += ms
      for (const [id, { cb, dueAt }] of [...queue.entries()]) {
        if (dueAt <= now) {
          queue.delete(id)
          cb()
        }
      }
    }
  }
}

describe("createMultiKeyMachine — single-count handler", () => {
  it("fires after the debounce window elapses", () => {
    const onSingle = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine({ 1: onSingle }, 300, t.setTimer, t.clearTimer)
    m.press(mkKey({ escape: true }))
    t.advance(299)
    expect(onSingle).not.toHaveBeenCalled()
    t.advance(1)
    expect(onSingle).toHaveBeenCalledTimes(1)
  })
})

describe("createMultiKeyMachine — single + double handlers", () => {
  it("double-press fires the 2-handler and NOT the 1-handler", () => {
    const onSingle = jest.fn()
    const onDouble = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine(
      { 1: onSingle, 2: onDouble },
      300,
      t.setTimer,
      t.clearTimer
    )
    m.press(mkKey({ escape: true }))
    t.advance(100)
    m.press(mkKey({ escape: true }))
    t.advance(300)
    expect(onSingle).not.toHaveBeenCalled()
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it("single slow press only fires the 1-handler", () => {
    const onSingle = jest.fn()
    const onDouble = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine(
      { 1: onSingle, 2: onDouble },
      300,
      t.setTimer,
      t.clearTimer
    )
    m.press(mkKey({ escape: true }))
    t.advance(350)
    expect(onSingle).toHaveBeenCalledTimes(1)
    expect(onDouble).not.toHaveBeenCalled()
  })
})

describe("createMultiKeyMachine — 2-handler only, with 3 presses", () => {
  it("falls through to the 2-handler (highest registered <= hit)", () => {
    const onDouble = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine({ 2: onDouble }, 300, t.setTimer, t.clearTimer)
    m.press(mkKey({ escape: true }))
    t.advance(50)
    m.press(mkKey({ escape: true }))
    t.advance(50)
    m.press(mkKey({ escape: true }))
    t.advance(300)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it("a single press with no 1-handler is ignored", () => {
    const onDouble = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine({ 2: onDouble }, 300, t.setTimer, t.clearTimer)
    m.press(mkKey({ escape: true }))
    t.advance(300)
    expect(onDouble).not.toHaveBeenCalled()
  })
})

describe("createMultiKeyMachine — cleanup", () => {
  it("prevents a pending handler from firing after cleanup", () => {
    const onSingle = jest.fn()
    const t = manualTimer()
    const m = createMultiKeyMachine({ 1: onSingle }, 300, t.setTimer, t.clearTimer)
    m.press(mkKey({ escape: true }))
    m.cleanup()
    t.advance(500)
    expect(onSingle).not.toHaveBeenCalled()
  })
})

describe("useMultiKeyTrigger export shape", () => {
  it("is exported as a function (React hook)", () => {
    expect(typeof useMultiKeyTrigger).toBe("function")
  })
})

describe("MultiKeyTrigger namespace", () => {
  it("exposes DefaultWindowMs", () => {
    expect(MultiKeyTrigger.DefaultWindowMs).toBe(300)
  })
})
