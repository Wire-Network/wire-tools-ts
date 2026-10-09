import { useMemo, useRef, type KeyboardEvent } from "react"
import Box from "@mui/material/Box"
import Table from "@mui/material/Table"
import TableBody from "@mui/material/TableBody"
import TableCell from "@mui/material/TableCell"
import TableHead from "@mui/material/TableHead"
import TableRow from "@mui/material/TableRow"
import TableSortLabel from "@mui/material/TableSortLabel"
import { columnResizingFeature, columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { match } from "ts-pattern"

import {
  CellAlignment,
  CellFormatter,
  ResultSelection,
  SelectionFormat,
  SortDirection,
  type ColumnSort,
  type QueryRow,
  type ResultView,
  type ResultSearchHit
} from "@wireio/ql-shared"

import { AppAction } from "../../common/index.js"
import { Clipboard } from "../common/index.js"
import { ResultsActions, showContextMenu, UiActions, useAppDispatch, useAppSelector, type ResultTab } from "../store/index.js"
import { GridFilterRow } from "./GridFilterRow.js"

/** Column features the grid uses (sizing + resize; sort/filter are ql-shared's ResultView). */
const GridFeatures = tableFeatures({ columnSizingFeature, columnResizingFeature })
/** Column helper over result rows. */
const GridColumns = createColumnHelper<typeof GridFeatures, QueryRow>()

/** Props of {@link ResultsGrid}. */
export interface ResultsGridProps {
  /** The result tab. */
  tab: ResultTab
  /** Its client-side view. */
  view: ResultView
  /** The find-in-results hits over {@link view} (computed once by the panel). */
  hits: ResultSearchHit[]
}

/**
 * The virtualized results grid: TanStack Table (column sizing / resize) +
 * TanStack Virtual rendered with MUI Table primitives; multi-sort, filter row,
 * keyboard cell navigation, copy (Ctrl/Cmd+C), find-hit highlight, value
 * inspector on double-click and a native context menu.
 *
 * @param props - The tab, its view and the find hits.
 * @returns The grid.
 */
export function ResultsGrid({ tab, view, hits }: ResultsGridProps) {
  const dispatch = useAppDispatch(),
    { cursor, findHitIndex } = useAppSelector(state => state.ui),
    scrollRef = useRef<HTMLDivElement>(null),
    rows = useMemo(() => view.rows(view.fullRange()), [view]),
    columns = useMemo(
      () =>
        view.columns.map(column =>
          GridColumns.display({ id: column.name, header: column.name, size: ResultsGrid.DefaultColumnWidthPx })
        ),
      [view]
    ),
    table = useTable({ features: GridFeatures, columns, data: rows, columnResizeMode: "onChange" }),
    focusedHit = hits[findHitIndex],
    virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ResultsGrid.RowHeightPx,
      overscan: ResultsGrid.OverscanRows
    }),
    items = virtualizer.getVirtualItems(),
    paddingTop = items[0]?.start ?? 0,
    paddingBottom = virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (cursor == null) return
    const columnIndex = view.columns.findIndex(column => column.name === cursor.column)
    if ((event.ctrlKey || event.metaKey) && event.key === ResultsGrid.CopyKey) {
      event.preventDefault()
      void Clipboard.copy(ResultSelection.cell(view, cursor.rowIndex, cursor.column, SelectionFormat.tsv))
      return
    }
    const move = ResultsGrid.CursorMoves[event.key]
    if (move == null) return
    event.preventDefault()
    const rowIndex = Math.min(Math.max(cursor.rowIndex + move[0], 0), rows.length - 1),
      column = view.columns[Math.min(Math.max(columnIndex + move[1], 0), view.columns.length - 1)].name
    dispatch(UiActions.cursorMoved({ rowIndex, column }))
    virtualizer.scrollToIndex(rowIndex)
  }

  const onContextMenu = async (rowIndex: number, column: string) => {
    dispatch(UiActions.cursorMoved({ rowIndex, column }))
    const action = await dispatch(showContextMenu(...ResultsGrid.CellMenuActions))
    match(action)
      .with(AppAction.copyCell, () => void Clipboard.copy(ResultSelection.cell(view, rowIndex, column, SelectionFormat.tsv)))
      .with(AppAction.copyRow, () => void Clipboard.copy(ResultSelection.row(view, rowIndex, SelectionFormat.tsv)))
      .with(AppAction.copyColumn, () => void Clipboard.copy(ResultSelection.column(view, column, SelectionFormat.tsv)))
      .with(AppAction.copySelectionTsv, () => void Clipboard.copy(ResultSelection.range(view, view.fullRange(), SelectionFormat.tsv)))
      .with(AppAction.copySelectionJson, () =>
        void Clipboard.copy(ResultSelection.range(view, view.fullRange(), SelectionFormat.json))
      )
      .with(AppAction.inspectValue, () => dispatch(UiActions.inspectorChanged({ rowIndex, column })))
      .otherwise(() => undefined)
  }

  return (
    <Box
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="results-grid"
      sx={{ height: "100%", overflow: "auto", outline: "none" }}
    >
      <Table stickyHeader sx={{ tableLayout: "fixed", width: table.getTotalSize() }}>
        <TableHead>
          {table.getHeaderGroups().map(group => (
            <TableRow key={group.id}>
              {group.headers.map(header => {
                const sort = tab.view.sorts.find(candidate => candidate.column === header.id)
                return (
                  <TableCell key={header.id} sx={{ width: header.getSize(), position: "relative", userSelect: "none" }}>
                    <TableSortLabel
                      active={sort != null}
                      direction={sort?.direction ?? SortDirection.asc}
                      onClick={event =>
                        dispatch(
                          ResultsActions.viewPatched({
                            resultId: tab.id,
                            patch: { sorts: ResultsGrid.nextSorts(tab.view.sorts, header.id, event.shiftKey) }
                          })
                        )
                      }
                    >
                      {header.id}
                    </TableSortLabel>
                    <Box
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      sx={{ position: "absolute", right: 0, top: 0, height: "100%", width: 4, cursor: "col-resize" }}
                    />
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
          <GridFilterRow tab={tab} columns={view.columns.map(column => column.name)} />
        </TableHead>
        <TableBody>
          {paddingTop > 0 && (
            <TableRow>
              <TableCell colSpan={view.columns.length} sx={{ height: paddingTop, p: 0, border: 0 }} />
            </TableRow>
          )}
          {items.map(item => (
            <TableRow key={item.key} hover data-index={item.index} sx={{ height: ResultsGrid.RowHeightPx }}>
              {view.columns.map(column => {
                const selected = cursor?.rowIndex === item.index && cursor?.column === column.name,
                  hit = focusedHit?.rowIndex === item.index && focusedHit?.column === column.name
                return (
                  <TableCell
                    key={column.name}
                    align={CellFormatter.alignment(column) === CellAlignment.right ? "right" : "left"}
                    onClick={() => dispatch(UiActions.cursorMoved({ rowIndex: item.index, column: column.name }))}
                    onDoubleClick={() =>
                      dispatch(UiActions.inspectorChanged({ rowIndex: item.index, column: column.name }))
                    }
                    onContextMenu={event => {
                      event.preventDefault()
                      void onContextMenu(item.index, column.name)
                    }}
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      outline: selected ? 1 : 0,
                      outlineColor: "primary.main",
                      bgcolor: hit ? "action.selected" : undefined
                    }}
                  >
                    {CellFormatter.format(column, rows[item.index][column.name])}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
          {paddingBottom > 0 && (
            <TableRow>
              <TableCell colSpan={view.columns.length} sx={{ height: paddingBottom, p: 0, border: 0 }} />
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Box>
  )
}

/** Grid geometry + keys. */
export namespace ResultsGrid {
  /** Row height (px) — the virtualizer's estimate. */
  export const RowHeightPx = 26
  /** Rows rendered beyond the viewport. */
  export const OverscanRows = 20
  /** Default column width (px). */
  export const DefaultColumnWidthPx = 160
  /** Arrow-key cursor moves. */
  export const CursorMoves: Readonly<Record<string, [number, number]>> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }
  /** The copy shortcut key (with Ctrl/Cmd). */
  export const CopyKey = "c"
  /** A cell's context menu, in display order. */
  export const CellMenuActions = [
    AppAction.copyCell,
    AppAction.copyRow,
    AppAction.copyColumn,
    AppAction.copySelectionTsv,
    AppAction.copySelectionJson,
    AppAction.inspectValue
  ] as const

  /**
   * Next multi-sort after clicking a header: asc → desc → removed; shift adds to the sort list.
   *
   * @param sorts - Current sorts.
   * @param column - Clicked column.
   * @param additive - Shift held.
   * @returns The new sorts.
   */
  export function nextSorts(sorts: ColumnSort[], column: string, additive: boolean): ColumnSort[] {
    const current = sorts.find(sort => sort.column === column),
      others = additive ? sorts.filter(sort => sort.column !== column) : [],
      next = match(current?.direction)
        .with(SortDirection.asc, () => [{ column, direction: SortDirection.desc }])
        .with(SortDirection.desc, () => [])
        .otherwise(() => [{ column, direction: SortDirection.asc }])
    return [...others, ...next]
  }
}
