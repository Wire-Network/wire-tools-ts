import InputBase from "@mui/material/InputBase"
import TableCell from "@mui/material/TableCell"
import TableRow from "@mui/material/TableRow"

import { ResultsActions, useAppDispatch, type ResultTab } from "../store/index.js"

/** Props of {@link GridFilterRow}. */
export interface GridFilterRowProps {
  /** The result tab. */
  tab: ResultTab
  /** Visible column names in order. */
  columns: string[]
}

/**
 * One contains-filter input per visible column (case-insensitive over display
 * text — `ResultView` semantics, over THIS page's rows).
 *
 * @param props - Tab and columns.
 * @returns The filter row.
 */
export function GridFilterRow({ tab, columns }: GridFilterRowProps) {
  const dispatch = useAppDispatch(),
    textOf = (column: string) => tab.view.filters.find(filter => filter.column === column)?.text ?? ""
  return (
    <TableRow>
      {columns.map(column => (
        <TableCell key={column} sx={{ py: 0 }}>
          <InputBase
            fullWidth
            placeholder={GridFilterRow.Placeholder}
            value={textOf(column)}
            slotProps={{ input: { "aria-label": `Filter ${column}` } }}
            onChange={event =>
              dispatch(
                ResultsActions.viewPatched({
                  resultId: tab.id,
                  patch: {
                    filters: [
                      ...tab.view.filters.filter(filter => filter.column !== column),
                      ...(event.target.value.length === 0 ? [] : [{ column, text: event.target.value }])
                    ]
                  }
                })
              )
            }
          />
        </TableCell>
      ))}
    </TableRow>
  )
}

/** Filter-row constants. */
export namespace GridFilterRow {
  /** Placeholder of a filter cell. */
  export const Placeholder = "filter"
}
