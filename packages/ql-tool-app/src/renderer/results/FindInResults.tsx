import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown"
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp"
import Box from "@mui/material/Box"
import IconButton from "@mui/material/IconButton"
import InputBase from "@mui/material/InputBase"
import Typography from "@mui/material/Typography"

import type { ResultSearchHit } from "@wireio/ql-shared"

import { UiActions, useAppDispatch, useAppSelector } from "../store/index.js"

/** Props of {@link FindInResults}. */
export interface FindInResultsProps {
  /** The hits of the find text over the result view (computed once by the panel). */
  hits: ResultSearchHit[]
}

/**
 * Find-in-results: case-insensitive match over display-formatted cells
 * (`ResultSearch`), with previous/next hit navigation (the grid highlights and
 * scrolls to the focused hit).
 *
 * @param props - The hits.
 * @returns The find bar.
 */
export function FindInResults({ hits }: FindInResultsProps) {
  const dispatch = useAppDispatch(),
    { findText, findHitIndex } = useAppSelector(state => state.ui),
    select = (index: number) => {
      if (hits.length === 0) return
      const next = (index + hits.length) % hits.length
      dispatch(UiActions.findHitSelected(next))
      dispatch(UiActions.cursorMoved({ rowIndex: hits[next].rowIndex, column: hits[next].column }))
    }
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1 }}>
      <InputBase
        autoFocus
        placeholder="Find in results"
        value={findText}
        slotProps={{ input: { "aria-label": "Find in results" } }}
        onChange={event => dispatch(UiActions.findTextChanged(event.target.value))}
        onKeyDown={event => {
          if (event.key === "Enter") select(findHitIndex + (event.shiftKey ? -1 : 1))
        }}
      />
      <Typography variant="caption" data-testid="find-count">
        {hits.length === 0 ? "0/0" : `${findHitIndex + 1}/${hits.length}`}
      </Typography>
      <IconButton aria-label="Previous hit" onClick={() => select(findHitIndex - 1)}>
        <KeyboardArrowUpIcon fontSize="small" />
      </IconButton>
      <IconButton aria-label="Next hit" onClick={() => select(findHitIndex + 1)}>
        <KeyboardArrowDownIcon fontSize="small" />
      </IconButton>
    </Box>
  )
}
