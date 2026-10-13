import { Text } from "ink"

import { ResultSummary } from "@wireio/ql-shared"

import { Panel, WindowedList } from "../components/index.js"
import { TuiColorRole, TuiPalette } from "../editor/index.js"
import { KeyBindings, KeyName } from "../keys/index.js"
import { CatalogState, useAppSelector } from "../store/index.js"

/** Props of {@link SchemaTreePanel}. */
export interface SchemaTreePanelProps {
  /** Focused (cursor shown, brand border). */
  focused: boolean
  /** Panel width. */
  width: number
  /** Visible tree rows. */
  height: number
}

/** Indent per tree depth. */
const IndentUnit = "  "

/**
 * The schema tree (owners → tables → fields) from the catalog snapshot. Enter
 * expands an owner / table or inserts its qualified name; {@link SchemaTreePanel.DescribeInput}
 * describes a table.
 *
 * @param props - Focus and size.
 * @returns The panel element.
 */
export function SchemaTreePanel({ focused, width, height }: SchemaTreePanelProps) {
  const catalog = useAppSelector(state => state.catalog),
    rows = CatalogState.treeRows(catalog),
    visible = WindowedList.window(rows, catalog.cursor, height)
  return (
    <Panel title={SchemaTreePanel.Title} focused={focused} width={width}>
      {visible.items.map((row, index) => (
        <Text key={row.key} inverse={focused && visible.offset + index === catalog.cursor} wrap="truncate">
          {`${IndentUnit.repeat(row.depth)}${row.label}`}
        </Text>
      ))}
      {catalog.loading && <Text dimColor>{SchemaTreePanel.LoadingText}</Text>}
      {catalog.error != null && <Text color={TuiPalette[TuiColorRole.error]}>{catalog.error}</Text>}
    </Panel>
  )
}

/** Schema panel constants. */
export namespace SchemaTreePanel {
  /** Panel title. */
  export const Title = "Schema"
  /** Shown while owners load. */
  export const LoadingText = "loading…"
  /** Input that describes the table under the cursor (the workbench routes it). */
  export const DescribeInput = "d"
  /** Key hint of the focused tree (the status bar shows it). */
  export const KeysHint = ResultSummary.join([
    `${KeyBindings.UpDownLabel} move`,
    KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "expand/insert"),
    KeyBindings.hint(KeyBindings.letterChord(DescribeInput), "describe")
  ])
  /** Every tree key, spelled for the Help route (move, expand/insert, expand table, describe). */
  export const KeysLabel = [
    KeyBindings.UpDownLabel,
    KeyBindings.namedLabel(KeyName.return),
    KeyBindings.namedLabel(KeyName.rightArrow),
    KeyBindings.label(KeyBindings.letterChord(DescribeInput))
  ].join(" ")
}
