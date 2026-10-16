import Table from "@mui/material/Table"
import TableBody from "@mui/material/TableBody"
import TableCell from "@mui/material/TableCell"
import TableRow from "@mui/material/TableRow"

/** One labelled value row. */
export interface KeyValueEntry {
  /** Label. */
  label: string
  /** Value text. */
  value: string
}

/** Props of {@link KeyValueTable}. */
export interface KeyValueTableProps {
  /** Rows in order. */
  entries: KeyValueEntry[]
  /** Test id. */
  testId?: string
}

/**
 * A two-column label/value table (Stats, State, Form, inspector).
 *
 * @param props - Entries.
 * @returns The table.
 */
export function KeyValueTable({ entries, testId }: KeyValueTableProps) {
  return (
    <Table data-testid={testId}>
      <TableBody>
        {entries.map(entry => (
          <TableRow key={entry.label}>
            <TableCell component="th" sx={{ fontWeight: 600, width: "30%" }}>
              {entry.label}
            </TableCell>
            <TableCell sx={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{entry.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
