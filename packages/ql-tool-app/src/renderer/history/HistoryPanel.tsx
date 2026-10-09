import { useEffect, useMemo } from "react"
import Button from "@mui/material/Button"
import InputBase from "@mui/material/InputBase"
import { debounce } from "lodash"

import type { QueryHistoryEntry } from "@wireio/ql-shared"

import { QueryDrawer, QueryListItem } from "../components/index.js"
import {
  clearHistory,
  HistoryActions,
  loadHistory,
  openAndRunQuery,
  UiSurface,
  useAppDispatch,
  useAppSelector,
  WorkspaceActions
} from "../store/index.js"

/**
 * The history drawer (shared `history.jsonl` with `wql`): search (reloaded
 * once typing pauses), open in a new tab (click), re-run in a new tab (the
 * per-entry Re-run button), clear.
 *
 * @returns The drawer.
 */
export function HistoryPanel() {
  const dispatch = useAppDispatch(),
    { entries, search } = useAppSelector(state => state.history),
    reload = useMemo(() => debounce(() => void dispatch(loadHistory()), HistoryPanel.SearchDebounceMs), [dispatch])
  useEffect(() => () => reload.cancel(), [reload])
  return (
    <QueryDrawer
      surface={UiSurface.history}
      title="History"
      listTestId="history-list"
      actions={
        <Button size="small" onClick={() => void dispatch(clearHistory())}>
          Clear
        </Button>
      }
      toolbar={
        <InputBase
          placeholder="Search history"
          value={search}
          sx={{ px: 1 }}
          slotProps={{ input: { "aria-label": "Search history" } }}
          onChange={event => {
            dispatch(HistoryActions.searchChanged(event.target.value))
            reload()
          }}
        />
      }
    >
      {entries.map(entry => (
        <QueryListItem
          key={entry.id}
          primary={entry.query}
          primaryIsQuery
          secondary={HistoryPanel.describe(entry)}
          identity={entry.id}
          onOpen={() => dispatch(WorkspaceActions.tabAdded({ text: entry.query }))}
          onRerun={() => void dispatch(openAndRunQuery({ text: entry.query }))}
        />
      ))}
    </QueryDrawer>
  )
}

/** History drawer constants + texts. */
export namespace HistoryPanel {
  /** Pause after the last keystroke before the search reloads the list (ms). */
  export const SearchDebounceMs = 250

  /**
   * An entry's second line.
   *
   * @param entry - The history entry.
   * @returns `time · profile · outcome[ · N rows]`.
   */
  export function describe(entry: QueryHistoryEntry): string {
    const { executedAt, profile, outcome, returnedRows } = entry
    return `${executedAt} · ${profile} · ${outcome}${returnedRows == null ? "" : ` · ${returnedRows} rows`}`
  }
}
