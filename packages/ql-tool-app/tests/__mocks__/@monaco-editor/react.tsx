import { createElement, useEffect } from "react"

import * as monaco from "../monaco-editor.js"

/** The change event the mock forwards. */
interface MockChangeTarget {
  value: string
}

/** The textarea change event. */
interface MockChangeEvent {
  target: MockChangeTarget
}

/** A command registered through `addCommand`. */
interface MockCommand {
  keybinding: number
  handler: () => void
}

/** The editor surface QueryEditor's onMount uses. */
export interface MockEditor {
  commands: MockCommand[]
  addCommand: jest.Mock
  onDidChangeCursorSelection: jest.Mock
  getModel: jest.Mock
  focus: jest.Mock
}

/** Props the mock reads. */
interface MockEditorProps {
  value?: string
  language?: string
  onChange?: (value: string) => void
  beforeMount?: (api: typeof monaco) => void
  onMount?: (editor: MockEditor, api: typeof monaco) => void
}

/** Every editor the mock mounted (newest last). */
export const mountedEditors: MockEditor[] = []

/**
 * A fake standalone editor recording its commands.
 *
 * @returns The editor.
 */
function createMockEditor(): MockEditor {
  const commands: MockCommand[] = []
  return {
    commands,
    addCommand: jest.fn((keybinding: number, handler: () => void) => commands.push({ keybinding, handler })),
    onDidChangeCursorSelection: jest.fn(),
    getModel: jest.fn(() => null),
    focus: jest.fn()
  }
}

/**
 * A textarea standing in for the Monaco editor (jsdom cannot run Monaco); it
 * calls `beforeMount` / `onMount` with the monaco mock and a fake editor.
 *
 * @param props - value / language / onChange / beforeMount / onMount.
 * @returns A textarea.
 */
export default function Editor({ value, language, onChange, beforeMount, onMount }: MockEditorProps) {
  useEffect(() => {
    const editor = createMockEditor()
    beforeMount?.(monaco)
    mountedEditors.push(editor)
    onMount?.(editor, monaco)
  }, [])
  return createElement("textarea", {
    "data-testid": `monaco-${language}`,
    value,
    onChange: (event: MockChangeEvent) => onChange?.(event.target.value)
  })
}

/** loader.config is a no-op. */
export const loader = { config: jest.fn() }
