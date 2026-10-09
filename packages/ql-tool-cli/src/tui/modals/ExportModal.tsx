import Path from "node:path"

import { useState } from "react"
import { Text } from "ink"
import { match } from "ts-pattern"

import { OutputFormat, ResultRenderer, ResultSummary } from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import { ModalFrame, TextInputLine } from "../components/index.js"
import { useLineInput, type TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, KeyName } from "../keys/index.js"
import { ExportScope, TuiServiceId, useTuiService, type QueryService } from "../services/index.js"
import { MessageLevel, UiActions, useAppDispatch } from "../store/index.js"

const log = getLogger(__filename)

/** The export dialog's choices (the file name is the line input). */
export interface ExportChoice {
  /** Output format. */
  format: OutputFormat
  /** Rows covered. */
  scope: ExportScope
  /** Header row on/off. */
  header: boolean
}

/** Ctrl+<this> toggles the scope. */
const ScopeToggleInput = "t"
/** Ctrl+<this> toggles the header. */
const HeaderToggleInput = "e"

/**
 * Export (Alt+E): format (Tab cycles), scope page|all (Ctrl+T), header on/off
 * (Ctrl+E), file name (typed); Enter writes through the shared
 * `ResultRenderer`, Esc cancels.
 *
 * @returns The modal element.
 */
export function ExportModal() {
  const dispatch = useAppDispatch(),
    queryService = useTuiService<QueryService>(TuiServiceId.query),
    [choice, setChoice] = useState<ExportChoice>(() => ExportModal.initialChoice()),
    close = () => dispatch(UiActions.modalClosed()),
    file = useLineInput(ExportModal.fileName(ExportModal.DefaultFileStem, ExportModal.initialChoice().format), {
      onCancel: close,
      onSubmit: text => {
        close()
        queryService.exportResult({ ...choice, file: text }).catch(error => {
          const message = NestedError.toError(error).message
          log.warn(`export failed: ${message}`)
          dispatch(UiActions.message(MessageLevel.error, `export failed: ${message}`))
        })
      },
      onKey: event => ExportModal.handleChoiceKey(event, choice, setChoice, file.replace, file.buffer.text)
    })
  return (
    <ModalFrame title={ExportModal.Title} keysHint={ExportModal.KeysHint}>
      <Text>{ExportModal.choiceText(choice)}</Text>
      <TextInputLine buffer={file.buffer} />
    </ModalFrame>
  )
}

/** Export dialog math (pure). */
export namespace ExportModal {
  /** Title. */
  export const Title = "Export results"
  /** Key hint. */
  export const KeysHint = ResultSummary.join([
    KeyBindings.hint(KeyBindings.namedChord(KeyName.tab), "format"),
    KeyBindings.hint(KeyBindings.letterChord(ScopeToggleInput, { ctrl: true }), "page/all"),
    KeyBindings.hint(KeyBindings.letterChord(HeaderToggleInput, { ctrl: true }), "header"),
    KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "export"),
    KeyBindings.hint(KeyBindings.namedChord(KeyName.escape), "cancel")
  ])
  /** Default file name stem. */
  export const DefaultFileStem = "wql-export"

  /**
   * The initial choice: CSV of the page with a header.
   *
   * @returns The choice.
   */
  export function initialChoice(): ExportChoice {
    return { format: OutputFormat.csv, scope: ExportScope.page, header: true }
  }

  /**
   * The format after `format` (wrapping).
   *
   * @param format - Current format.
   * @returns The next format.
   */
  export function nextFormat(format: OutputFormat): OutputFormat {
    const formats = Object.values(OutputFormat)
    return formats[(formats.indexOf(format) + 1) % formats.length]
  }

  /**
   * A file name with the extension of `format` (`Path.parse` keeps the directory
   * and replaces only the extension).
   *
   * @param file - The current file name (any extension, or none).
   * @param format - The format.
   * @returns The file name.
   */
  export function fileName(file: string, format: OutputFormat): string {
    const { dir, name } = Path.parse(file)
    return Path.format({ dir, name, ext: `.${ResultRenderer.fileExtension(format)}` })
  }

  /**
   * The choice line.
   *
   * @param choice - The choice.
   * @returns `format … · scope … · header on|off`.
   */
  export function choiceText(choice: ExportChoice): string {
    return ResultSummary.join([`format ${choice.format}`, `scope ${choice.scope}`, `header ${choice.header ? "on" : "off"}`])
  }

  /**
   * The dialog's own keys (offered before file-name editing): Tab cycles the
   * format (and the file's extension), Ctrl+T the scope, Ctrl+E the header.
   *
   * @param event - The press.
   * @param choice - The current choice.
   * @param setChoice - Replaces the choice.
   * @param replaceFile - Replaces the file name.
   * @param file - The current file name.
   * @returns Whether the press was consumed.
   */
  export function handleChoiceKey(
    event: TuiKeyEvent,
    choice: ExportChoice,
    setChoice: (next: ExportChoice) => void,
    replaceFile: (text: string) => void,
    file: string
  ): boolean {
    return match(event)
      .with({ key: { tab: true } }, () => {
        const format = nextFormat(choice.format)
        setChoice({ ...choice, format })
        replaceFile(fileName(file, format))
        return true
      })
      .with({ key: { ctrl: true }, input: ScopeToggleInput }, () => {
        setChoice({ ...choice, scope: choice.scope === ExportScope.page ? ExportScope.all : ExportScope.page })
        return true
      })
      .with({ key: { ctrl: true }, input: HeaderToggleInput }, () => {
        setChoice({ ...choice, header: !choice.header })
        return true
      })
      .otherwise(() => false)
  }
}
