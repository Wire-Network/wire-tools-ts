import { useState } from "react"
import { Text } from "ink"
import { noop } from "lodash"
import { match } from "ts-pattern"

import { ResultSummary, type QueryColumn } from "@wireio/ql-shared"

import { moveCursor } from "../../utils/index.js"

import { ModalFrame } from "../components/index.js"
import { useTuiKeys, type TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, KeyName, KeyScope } from "../keys/index.js"
import {
  MessageLevel,
  ResultsActions,
  ResultsState,
  UiActions,
  useAppDispatch,
  useAppSelector,
  type TuiDispatch
} from "../store/index.js"

/** What a column-chooser keypress acts on. */
export interface ColumnsModalContext {
  /** Store dispatch. */
  dispatch: TuiDispatch
  /** The result's columns, in result order. */
  columns: QueryColumn[]
  /** The hidden column names. */
  hiddenColumns: string[]
}

/** Space toggles the column under the cursor. */
const ToggleInput = KeyBindings.SpaceInput
/** `a` shows every column. */
const ShowAllInput = "a"

/**
 * Column chooser (`c` in the grid): the loaded result's columns with a shown /
 * hidden mark; ↑↓ move, Space shows or hides the column, `a` shows all, Enter
 * or Esc closes. The projection is client-side over the loaded page and also
 * applies to page exports; the last visible column cannot be hidden.
 *
 * @returns The modal element.
 */
export function ColumnsModal() {
  const dispatch = useAppDispatch(),
    results = useAppSelector(state => state.results),
    columns = ResultsState.success(results)?.result.columns ?? [],
    [cursor, setCursor] = useState(0),
    context: ColumnsModalContext = { dispatch, columns, hiddenColumns: results.hiddenColumns }
  useTuiKeys(KeyScope.editor, event => ColumnsModal.handleKey(event, columns[cursor]?.name, context, delta =>
    setCursor(current => moveCursor(current, delta, columns.length))
  ))
  return (
    <ModalFrame title={ColumnsModal.Title} keysHint={ColumnsModal.KeysHint}>
      {columns.map((column, index) => (
        <Text key={column.name} inverse={index === cursor}>
          {ColumnsModal.rowText(column, results.hiddenColumns)}
        </Text>
      ))}
    </ModalFrame>
  )
}

/** Column chooser constants and pure helpers. */
export namespace ColumnsModal {
  /** Title. */
  export const Title = "Columns (this page; also page exports)"
  /** Key hint. */
  export const KeysHint = ResultSummary.join([
    `${KeyBindings.UpDownLabel} move`,
    KeyBindings.hint(KeyBindings.letterChord(ToggleInput), "show/hide"),
    KeyBindings.hint(KeyBindings.letterChord(ShowAllInput), "show all"),
    `${KeyBindings.namedLabel(KeyName.return)}/${KeyBindings.namedLabel(KeyName.escape)} close`
  ])
  /** Mark of a shown column. */
  export const ShownMark = "[x]"
  /** Mark of a hidden column. */
  export const HiddenMark = "[ ]"
  /** Warning when the last visible column would be hidden. */
  export const LastColumnWarning = "at least one column stays visible"

  /**
   * Route one keypress.
   *
   * @param event - The press.
   * @param column - The column under the cursor (undefined without columns).
   * @param context - Dispatch, columns and the hidden set.
   * @param moveBy - Moves the chooser cursor.
   */
  export function handleKey(event: TuiKeyEvent, column: string, context: ColumnsModalContext, moveBy: (delta: number) => void): void {
    match(event)
      .with({ key: { escape: true } }, { key: { return: true } }, () => context.dispatch(UiActions.modalClosed()))
      .with({ key: { upArrow: true } }, () => moveBy(-1))
      .with({ key: { downArrow: true } }, () => moveBy(1))
      .with({ input: ShowAllInput }, () => context.dispatch(ResultsActions.columnsShown()))
      .with({ input: ToggleInput }, () => toggle(column, context))
      .otherwise(noop)
  }

  /**
   * One chooser row: the mark, the name and the logical type.
   *
   * @param column - The column.
   * @param hiddenColumns - The hidden names.
   * @returns The row text.
   */
  export function rowText(column: QueryColumn, hiddenColumns: string[]): string {
    return `${hiddenColumns.includes(column.name) ? HiddenMark : ShownMark} ${column.name}  ${column.logical_type}`
  }

  /**
   * Show or hide `column`; hiding the last visible column is refused with a
   * Messages-tab warning.
   *
   * @param column - The column name (no-op when undefined).
   * @param context - Dispatch, columns and the hidden set.
   */
  export function toggle(column: string, { dispatch, columns, hiddenColumns }: ColumnsModalContext): void {
    if (column == null) return
    const visible = columns.filter(candidate => !hiddenColumns.includes(candidate.name))
    if (!hiddenColumns.includes(column) && visible.length <= 1) {
      dispatch(UiActions.message(MessageLevel.warn, LastColumnWarning))
      return
    }
    dispatch(ResultsActions.columnToggled(column))
  }
}
