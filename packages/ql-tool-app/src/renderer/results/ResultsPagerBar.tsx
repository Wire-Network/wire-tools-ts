import FirstPageIcon from "@mui/icons-material/FirstPage"
import LastPageIcon from "@mui/icons-material/LastPage"
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore"
import NavigateNextIcon from "@mui/icons-material/NavigateNext"
import Box from "@mui/material/Box"
import Chip from "@mui/material/Chip"
import IconButton from "@mui/material/IconButton"
import MenuItem from "@mui/material/MenuItem"
import TextField from "@mui/material/TextField"
import Typography from "@mui/material/Typography"

import { PageSizeMode, QueryExecutionStatus, QueryPager, ResultSummary } from "@wireio/ql-shared"

import { fetchPage, Results, ResultTabStatus, useAppDispatch, type PagerState, type ResultTab } from "../store/index.js"

/** Props of {@link ResultsPagerBar}. */
export interface ResultsPagerBarProps {
  /** The result tab. */
  tab: ResultTab
}

/**
 * Server paging: page-size choices + All, first/previous/next/last (each a
 * server request), `page N/M · total · block`, and a chip when this page's
 * block differs from the previous page's.
 *
 * @param props - The tab.
 * @returns The bar.
 */
export function ResultsPagerBar({ tab }: ResultsPagerBarProps) {
  const dispatch = useAppDispatch(),
    pages = ResultsPagerBar.pageCount(tab),
    running = tab.status === ResultTabStatus.running,
    paged = tab.pager.mode === PageSizeMode.paged,
    blockId = Results.blockIdOf(tab.execution),
    go = (pager: PagerState) => void dispatch(fetchPage(pager)),
    goPage = (page: number) => go({ ...tab.pager, page })
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, borderTop: 1, borderColor: "divider" }}>
      <TextField
        select
        value={paged ? tab.pager.pageSize : ResultsPagerBar.AllValue}
        variant="standard"
        disabled={running}
        slotProps={{ htmlInput: { "aria-label": "Page size" } }}
        onChange={event =>
          event.target.value === ResultsPagerBar.AllValue
            ? go({ ...tab.pager, mode: PageSizeMode.all, page: QueryPager.FirstPage })
            : go({ mode: PageSizeMode.paged, pageSize: Number(event.target.value), page: QueryPager.FirstPage })
        }
      >
        {QueryPager.PageSizeChoices.map(size => (
          <MenuItem key={size} value={size}>
            {size} rows
          </MenuItem>
        ))}
        <MenuItem value={ResultsPagerBar.AllValue}>All</MenuItem>
      </TextField>
      <IconButton
        aria-label="First page"
        disabled={running || !paged || tab.pager.page <= QueryPager.FirstPage}
        onClick={() => goPage(QueryPager.FirstPage)}
      >
        <FirstPageIcon fontSize="small" />
      </IconButton>
      <IconButton
        aria-label="Previous page"
        disabled={running || !paged || tab.pager.page <= QueryPager.FirstPage}
        onClick={() => goPage(tab.pager.page - 1)}
      >
        <NavigateBeforeIcon fontSize="small" />
      </IconButton>
      <IconButton
        aria-label="Next page"
        disabled={running || !paged || tab.pager.page >= pages}
        onClick={() => goPage(tab.pager.page + 1)}
      >
        <NavigateNextIcon fontSize="small" />
      </IconButton>
      <IconButton aria-label="Last page" disabled={running || !paged || tab.pager.page >= pages} onClick={() => goPage(pages)}>
        <LastPageIcon fontSize="small" />
      </IconButton>
      <Typography variant="body2" data-testid="pager-label">
        {ResultsPagerBar.label(tab)}
      </Typography>
      {tab.previousBlockId != null && blockId != null && blockId !== tab.previousBlockId && (
        <Chip size="small" color="warning" label={ResultsPagerBar.SnapshotChangedText} />
      )}
    </Box>
  )
}

/** Pager-bar constants. */
export namespace ResultsPagerBar {
  /** Select value of the "All" choice. */
  export const AllValue = PageSizeMode.all
  /** Text of the differing-snapshot chip. */
  export const SnapshotChangedText = "page snapshot differs from previous page"

  /**
   * The page label of a tab — the shared `page N/M · rows a–b of total · block N`
   * (`ResultSummary.describe`, as `wql` and the TUI print it); empty before a success.
   *
   * @param tab - The tab.
   * @returns The label.
   */
  export function label(tab: ResultTab): string {
    const execution = tab.execution
    if (execution?.status !== QueryExecutionStatus.success) return ""
    return ResultSummary.describe(execution.result, tab.pager.mode === PageSizeMode.all ? null : tab.pager.pageSize)
  }

  /**
   * Total pages of a tab — the count the label shows (1 before a success or in All mode).
   *
   * @param tab - The tab.
   * @returns The page count.
   */
  export function pageCount(tab: ResultTab): number {
    const execution = tab.execution
    return execution?.status === QueryExecutionStatus.success && tab.pager.mode === PageSizeMode.paged
      ? ResultSummary.pageCount(execution.result.page, tab.pager.pageSize)
      : QueryPager.FirstPage
  }
}
