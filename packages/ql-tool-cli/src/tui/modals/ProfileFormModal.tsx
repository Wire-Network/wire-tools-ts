import { useState } from "react"
import { Box, Text, type Key } from "ink"
import { match } from "ts-pattern"

import { ConnectionProfileForm, ResultSummary, type ConnectionProfile } from "@wireio/ql-shared"

import { ModalFrame, TextInputLine } from "../components/index.js"
import { TextBuffer, TuiColorRole, TuiPalette, type TextBufferState } from "../editor/index.js"
import { useTuiKeys } from "../hooks/index.js"
import { KeyBindings, KeyName, KeyScope } from "../keys/index.js"

/** One editable buffer per form field. */
export type ProfileFormBuffers = Record<keyof ConnectionProfileForm, TextBufferState>

/** The editor's state: the field buffers and the focused field. */
export interface ProfileFormState {
  /** Field buffers. */
  buffers: ProfileFormBuffers
  /** Index into {@link ProfileFormModal.Fields} of the focused field. */
  field: number
}

/** One labelled form field (the labels the GUI connection manager uses). */
export interface ProfileFormField {
  /** Form member. */
  key: keyof ConnectionProfileForm
  /** Label. */
  label: string
}

/** Props of {@link ProfileFormModal}. */
export interface ProfileFormModalProps {
  /** Title line ("Add" / "Edit"). */
  title: string
  /** The form to start from. */
  initial: ConnectionProfileForm
  /** Enter with a valid form. */
  onSubmit: (profile: ConnectionProfile) => void
  /** Esc. */
  onCancel: () => void
}

/**
 * Add / edit a connection profile: name, endpoint, transport timeout, server
 * timeout, retries and owners (the GUI connection manager's fields, validated
 * by the shared {@link ConnectionProfileForm}). Tab / ↓ next field, Shift+Tab /
 * ↑ previous, Enter saves (an invalid form shows the field messages), Esc cancels.
 *
 * @param props - Title, initial form, handlers.
 * @returns The modal element.
 */
export function ProfileFormModal({ title, initial, onSubmit, onCancel }: ProfileFormModalProps) {
  const [state, setState] = useState(() => ProfileFormModal.createState(initial)),
    [error, setError] = useState<string>(null)
  useTuiKeys(KeyScope.editor, event =>
    match(event)
      .with({ key: { escape: true } }, () => onCancel())
      .with({ key: { return: true } }, () =>
        ConnectionProfileForm.toProfile(ProfileFormModal.toForm(state)).match({ Left: setError, Right: onSubmit })
      )
      .otherwise(({ input, key }) => setState(current => ProfileFormModal.applyKey(current, input, key)))
  )
  return (
    <ModalFrame title={title} keysHint={ProfileFormModal.KeysHint}>
      {ProfileFormModal.Fields.map((field, index) => (
        <Box key={field.key}>
          <Text inverse={index === state.field}>{ProfileFormModal.labelText(field)}</Text>
          <TextInputLine buffer={state.buffers[field.key]} focused={index === state.field} />
        </Box>
      ))}
      {error != null && <Text color={TuiPalette[TuiColorRole.error]}>{error}</Text>}
    </ModalFrame>
  )
}

/** Profile editor constants and pure state transitions. */
export namespace ProfileFormModal {
  /** The fields in display / Tab order. */
  export const Fields: readonly ProfileFormField[] = [
    { key: "name", label: "Name" },
    { key: "endpoint", label: "Endpoint URL" },
    { key: "transportTimeoutMs", label: "Transport timeout (ms)" },
    { key: "queryTimeoutMs", label: "Server timeout (ms, blank = server default)" },
    { key: "retries", label: "Retries" },
    { key: "owners", label: "Owners (comma separated, blank = system contracts)" }
  ] as const
  /** Key hint. */
  export const KeysHint = ResultSummary.join([
    `${KeyBindings.namedLabel(KeyName.tab)}/${KeyBindings.namedLabel(KeyName.downArrow)} next field`,
    `${KeyBindings.label(KeyBindings.namedChord(KeyName.tab, { shift: true }))}/${KeyBindings.namedLabel(KeyName.upArrow)} previous`,
    KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "save"),
    KeyBindings.hint(KeyBindings.namedChord(KeyName.escape), "cancel")
  ])
  /** Separator between a label and its value. */
  export const LabelSeparator = ": "

  /**
   * The editor state of a form (the first field focused).
   *
   * @param form - The form.
   * @returns The state.
   */
  export function createState(form: ConnectionProfileForm): ProfileFormState {
    const buffers = Object.fromEntries(Fields.map(({ key }) => [key, TextBuffer.create(form[key])])) as ProfileFormBuffers
    return { buffers, field: 0 }
  }

  /**
   * The form held by the editor.
   *
   * @param state - The editor state.
   * @returns The form.
   */
  export function toForm(state: ProfileFormState): ConnectionProfileForm {
    return Object.fromEntries(Fields.map(({ key }) => [key, state.buffers[key].text])) as ConnectionProfileForm
  }

  /**
   * Apply one non-submitting keypress: field navigation, else text editing of
   * the focused field.
   *
   * @param state - The editor state.
   * @param input - Ink `input`.
   * @param key - Ink `Key`.
   * @returns The new state.
   */
  export function applyKey(state: ProfileFormState, input: string, key: Key): ProfileFormState {
    const step = (key.tab && key.shift) || key.upArrow ? -1 : key.tab || key.downArrow ? 1 : 0
    if (step !== 0) return { ...state, field: (state.field + step + Fields.length) % Fields.length }
    const { key: focused } = Fields[state.field]
    return { ...state, buffers: { ...state.buffers, [focused]: TextBuffer.applyKey(state.buffers[focused], input, key, false) } }
  }

  /**
   * A field's label column.
   *
   * @param field - The field.
   * @returns The label text.
   */
  export function labelText(field: ProfileFormField): string {
    return `${field.label}${LabelSeparator}`
  }
}
