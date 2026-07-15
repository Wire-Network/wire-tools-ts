import { ExitConfirmModal } from "@wireio/debugging-client-tool-tui/components/modals/ExitConfirmModal.js"

type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageUp: boolean
  pageDown: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
}

const ink = require("ink") as { useInput: jest.Mock }

function press(input: string, key: Partial<Key> = {}): void {
  const handler = ink.useInput.mock.calls.at(-1)?.[0] as
    | ((i: string, k: Key) => void)
    | undefined
  if (!handler) return
  handler(input, {
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
    ...key
  } as Key)
}

beforeEach(() => {
  ink.useInput.mockReset()
})

describe("ExitConfirmModal", () => {
  it("calls onConfirm for y / Y / Enter", () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("y")
    expect(onConfirm).toHaveBeenCalledTimes(1)
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("Y")
    expect(onConfirm).toHaveBeenCalledTimes(2)
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledTimes(3)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("calls onCancel for n / N / Esc", () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("n")
    expect(onCancel).toHaveBeenCalledTimes(1)
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("N")
    expect(onCancel).toHaveBeenCalledTimes(2)
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("", { escape: true })
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("ignores unrelated keypresses", () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    ;(ExitConfirmModal as any)({ onConfirm, onCancel })
    press("x")
    press("z")
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
