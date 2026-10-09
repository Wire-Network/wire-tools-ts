import { Text } from "ink"

import { ResultSummary } from "@wireio/ql-shared"

import { ModalFrame, TextInputLine } from "../components/index.js"
import { useLineInput } from "../hooks/index.js"
import { KeyBindings, KeyName } from "../keys/index.js"

/** Props of {@link PromptModal}. */
export interface PromptModalProps {
  /** Title line. */
  title: string
  /** Initial text. */
  initial: string
  /** Optional hint under the input. */
  hint?: string
  /** Enter. */
  onSubmit: (text: string) => void
  /** Esc. */
  onCancel: () => void
}

/**
 * A one-line text prompt (filter text, saved-query name, offset/limit window,
 * find text): Enter submits, Esc cancels.
 *
 * @param props - Title, initial text, handlers.
 * @returns The modal element.
 */
export function PromptModal({ title, initial, hint, onSubmit, onCancel }: PromptModalProps) {
  const { buffer } = useLineInput(initial, { onSubmit, onCancel })
  return (
    <ModalFrame title={title} keysHint={PromptModal.KeysHint}>
      <TextInputLine buffer={buffer} />
      {hint != null && <Text dimColor>{hint}</Text>}
    </ModalFrame>
  )
}

/** Prompt constants. */
export namespace PromptModal {
  /** Key hint line. */
  export const KeysHint = ResultSummary.join([
    KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "accept"),
    KeyBindings.hint(KeyBindings.namedChord(KeyName.escape), "cancel")
  ])
}
