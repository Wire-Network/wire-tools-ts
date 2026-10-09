import Table from "@mui/material/Table"
import TableBody from "@mui/material/TableBody"
import TableCell from "@mui/material/TableCell"
import TableHead from "@mui/material/TableHead"
import TableRow from "@mui/material/TableRow"

import type { QueryColumn } from "@wireio/ql-shared"

/** Props of {@link FieldTypesView}. */
export interface FieldTypesViewProps {
  /** The result's `columns[]`. */
  columns: QueryColumn[]
}

/**
 * The result's column metadata (name, logical type, ABI type, nullable, encoding).
 *
 * @param props - The columns.
 * @returns The table.
 */
export function FieldTypesView({ columns }: FieldTypesViewProps) {
  return (
    <Table data-testid="field-types">
      <TableHead>
        <TableRow>
          {FieldTypesView.Headers.map(header => (
            <TableCell key={header}>{header}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {columns.map(column => (
          <TableRow key={column.name}>
            <TableCell>{column.name}</TableCell>
            <TableCell>{column.logical_type}</TableCell>
            <TableCell>{column.abi_type ?? ""}</TableCell>
            <TableCell>{String(column.nullable)}</TableCell>
            <TableCell>{column.encoding}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Field Types constants. */
export namespace FieldTypesView {
  /** Header labels in display order (the engine's `columns[]` member names). */
  export const Headers = ["name", "logical_type", "abi_type", "nullable", "encoding"] as const
}
