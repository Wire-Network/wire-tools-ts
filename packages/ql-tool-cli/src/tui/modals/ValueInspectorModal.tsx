import { Text } from "ink"
import { noop } from "lodash"
import { match } from "ts-pattern"

import { ValueInspector } from "@wireio/ql-shared"

import { ModalFrame } from "../components/index.js"
import { useTuiKeys } from "../hooks/index.js"
import { KeyBindings, KeyName, KeyScope } from "../keys/index.js"
import { UiActions, selectCursorColumn, selectCursorRow, selectResultView, useAppDispatch, useAppSelector } from "../store/index.js"

/**
 * The cursor cell, inspected (`i`): full display text plus its labelled parts
 * (asset breakdown, decoded hex, ISO + epoch µs, JSON members). Esc / Enter closes.
 *
 * @returns The modal element.
 */
export function ValueInspectorModal() {
  const dispatch = useAppDispatch(),
    cursorRow = useAppSelector(state => selectCursorRow(state.results)),
    cursorColumn = useAppSelector(state => selectCursorColumn(state.results)),
    view = useAppSelector(state => selectResultView(state.results))
  useTuiKeys(KeyScope.global, event =>
    match(event)
      .with({ key: { escape: true } }, { key: { return: true } }, () => dispatch(UiActions.modalClosed()))
      .otherwise(noop)
  )
  if (cursorRow == null || cursorColumn == null) return <Text dimColor>{ValueInspectorModal.EmptyText}</Text>
  const column = view.columns[cursorColumn],
    inspected = ValueInspector.inspect(column, view.row(cursorRow)[column.name])
  return (
    <ModalFrame title={`${inspected.column} (${inspected.logicalType}, ${inspected.kind})`} keysHint={ValueInspectorModal.KeysHint}>
      <Text>{inspected.display}</Text>
      {inspected.fields.map(field => (
        <Text key={field.label}>
          <Text dimColor>{`${field.label}: `}</Text>
          {field.value}
        </Text>
      ))}
    </ModalFrame>
  )
}

/** Inspector constants. */
export namespace ValueInspectorModal {
  /** Shown without a cell. */
  export const EmptyText = "no cell selected"
  /** Key hint. */
  export const KeysHint = `${KeyBindings.namedLabel(KeyName.escape)} / ${KeyBindings.namedLabel(KeyName.return)} close`
}
