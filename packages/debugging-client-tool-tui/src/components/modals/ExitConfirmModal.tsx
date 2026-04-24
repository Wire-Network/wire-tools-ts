import React from "react"
import { Text, useInput } from "ink"
import { match } from "ts-pattern"
import { Modal } from "./Modal.js"

/** Props for {@link ExitConfirmModal}. */
export interface ExitConfirmModalProps {
  /** Fired when the user confirms (y / Y / Enter). */
  onConfirm(): void
  /** Fired when the user cancels (n / N / Esc). */
  onCancel(): void
}

/**
 * Gate for the TUI's stop/exit flow. Rendered as an overlay when the user
 * double-taps Esc or single-taps Ctrl+C. The Ctrl+C double-tap path in `App`
 * skips this modal entirely and exits immediately.
 *
 * Accepts `y` / `Y` / `Enter` to confirm, `n` / `N` / `Esc` to dismiss.
 */
export function ExitConfirmModal(props: ExitConfirmModalProps): React.ReactElement {
  useInput((input, key) => {
    match({ input, key })
      .with({ input: "y" }, () => props.onConfirm())
      .with({ input: "Y" }, () => props.onConfirm())
      .with({ key: { return: true } }, () => props.onConfirm())
      .with({ input: "n" }, () => props.onCancel())
      .with({ input: "N" }, () => props.onCancel())
      .with({ key: { escape: true } }, () => props.onCancel())
      .otherwise(() => {})
  })
  return (
    <Modal title="Exit TUI?" borderColor="red">
      <Text>Are you sure you want to quit?</Text>
      <Text dimColor>
        [y / Enter] confirm   [n / Esc] cancel   (double Ctrl+C skips this)
      </Text>
    </Modal>
  )
}
