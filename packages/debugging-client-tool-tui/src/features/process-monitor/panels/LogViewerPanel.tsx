import React, { useCallback, useEffect, useReducer, useRef } from "react"
import {
  Box,
  Text,
  useFocus,
  useFocusManager,
  useInput,
  useWindowSize
} from "ink"
import { match } from "ts-pattern"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { VirtualList } from "../../../components/VirtualList.js"
import { useService } from "../../../services/ServiceContext.js"
import { ServiceId } from "../../../services/ServiceId.js"
import {
  useAppDispatch,
  useAppSelector
} from "../../../store/Store.js"
import { selectLogViewer } from "../../../store/process-monitor/ProcessMonitorSelectors.js"
import {
  setLogViewerFollow,
  setLogViewerHorizontalOffset,
  setLogViewerOffset,
  setLogViewerPath,
  setSearchActive,
  setSearchQuery,
  toggleLocationColumn
} from "../../../store/process-monitor/ProcessMonitorSlice.js"
import {
  LogTailingEventName,
  LogTailingService,
  type LogTailingRuntime
} from "../LogTailingService.js"
import { LineRender, compileSearchRegex } from "../util/lineRender.js"
import { PidSources } from "../util/PidSources.js"
import {
  LogViewerJSONLine,
  jsonColumnBoundaries,
  nextColumnOffset,
  prevColumnOffset
} from "./LogViewerJSONLine.js"
import { LogViewerSearchInput } from "./LogViewerSearchInput.js"
import { LogViewerTextLine } from "./LogViewerTextLine.js"

function LogViewerBody(_: PanelComponentProps): React.ReactElement {
  const viewer = useAppSelector(selectLogViewer),
    dispatch = useAppDispatch(),
    { rows } = useWindowSize(),
    chromeRows =
      LogViewerPanel.ChromeLines +
      (viewer.searchActive ? LogViewerPanel.SearchInputRows : 0),
    viewportHeight = Math.max(
      LogViewerPanel.MinViewportHeight,
      rows - chromeRows
    ),
    tailing = useService<LogTailingService>(ServiceId.LogTailing),
    { isFocused } = useFocus({ id: LogViewerPanel.id }),
    { focus } = useFocusManager(),
    runtimeRef = useRef<LogTailingRuntime>(tailing.getRuntime()),
    [, forceRender] = useReducer((n: number) => n + 1, 0),
    runtime = runtimeRef.current,
    isJsonlPath = !!viewer.path?.endsWith(PidSources.JsonlExt),
    columnBoundaries = isJsonlPath
      ? jsonColumnBoundaries(viewer.locationVisible)
      : LogViewerPanel.NoColumnBoundaries

  /**
   * Close the active log: clear viewer state and hand focus back to the
   * process list. Used by the local Esc binding and by external actors
   * (e.g. the route's Esc fallback).
   */
  const dismiss = useCallback(() => {
    dispatch(setLogViewerPath(null))
    focus(LogViewerPanel.ParentFocusId)
  }, [dispatch, focus])

  /**
   * Subscribe to the service's typed update events. Runtime is stored in a
   * ref so non-display-relevant counter changes (e.g. `totalBytes` ticking up
   * while paused, or `totalLines` advancing without `follow`) do not trigger
   * a render. The `forceRender` reducer is only invoked when an update
   * actually changes what's on screen — currently:
   *   - the indexing flag flips
   *   - the file shrunk / inode changed (totalLines decreased)
   *   - we're following and totalLines advanced
   * Search-find-next uses the latest counter via `runtimeRef.current`, so
   * its scan loop is unaffected by render gating.
   */
  useEffect(() => {
    const onUpdate = (next: LogTailingRuntime) => {
      const prev = runtimeRef.current
      runtimeRef.current = next
      const indexingChanged = prev.indexing !== next.indexing,
        truncated = next.totalLines < prev.totalLines,
        followingAdvanced = viewer.follow && next.totalLines !== prev.totalLines
      if (indexingChanged || truncated || followingAdvanced) {
        forceRender()
      }
    }
    tailing.on(LogTailingEventName.Update, onUpdate)
    return () => {
      tailing.off(LogTailingEventName.Update, onUpdate)
    }
  }, [tailing, viewer.follow])

  /** Pin offset to tail when follow mode is on. */
  const effectiveOffset = viewer.follow
    ? Math.max(0, runtime.totalLines - viewportHeight)
    : viewer.offset

  /**
   * Stable window-fetcher passed to `VirtualList`. Without `useCallback`,
   * every panel render produced a new function reference, retriggering
   * VirtualList's window-fetch `useEffect` and (worse) cancelling its
   * in-flight fetch via the cleanup — so a fast keystroke could leave
   * `items` empty mid-flight, making the log content visibly disappear.
   */
  const fetchRange = useCallback(
    (from: number, count: number) => tailing.readWindow(from, count),
    [tailing]
  )

  /**
   * Scan forward from the current viewport for the next match of `query`.
   * Query semantics match the highlighter (`compileSearchRegex`):
   *   - `/pattern/` → JS regex
   *   - anything else → case-insensitive literal substring
   *
   * Reads in chunks via `tailing.readWindow` so we don't load the whole file.
   * On hit, pin the viewport to the matching line; on miss / invalid regex,
   * leave the viewport alone. Recursive — STYLE.md disallows `while` outside
   * deadline polling. Reads `totalLines` live from `runtimeRef` every
   * iteration so a tail-grown file lets the scan continue past the counter
   * we'd captured at callback-creation time.
   */
  const findNext = useCallback(
    async (query: string): Promise<void> => {
      if (query.length === 0) return
      dispatch(setSearchQuery(query))
      const regex = compileSearchRegex(query)
      if (!regex) return
      const matches = (line: string): boolean => {
        regex.lastIndex = 0
        return regex.test(line)
      }
      const scanFrom = async (from: number): Promise<void> => {
        if (from >= runtimeRef.current.totalLines) return
        const chunk = await tailing.readWindow(
          from,
          LogViewerPanel.SearchChunkLines
        )
        if (chunk.length === 0) return
        const hitInChunk = chunk.findIndex(matches)
        if (hitInChunk !== -1) {
          dispatch(setLogViewerOffset(from + hitInChunk))
          return
        }
        return scanFrom(from + chunk.length)
      }
      return scanFrom(effectiveOffset + 1)
    },
    [dispatch, effectiveOffset, tailing]
  )

  useInput(
    (input, key) => {
      if (!viewer.path) return
      match({ input, key })
        .with({ key: { upArrow: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset - 1))
        )
        .with({ key: { downArrow: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset + 1))
        )
        .with({ key: { pageUp: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset - viewportHeight))
        )
        .with({ key: { pageDown: true } }, () =>
          dispatch(setLogViewerOffset(effectiveOffset + viewportHeight))
        )
        .with({ key: { leftArrow: true } }, () =>
          dispatch(
            setLogViewerHorizontalOffset(
              prevColumnOffset(
                columnBoundaries,
                viewer.horizontalOffset,
                LogViewerPanel.HorizontalStep
              )
            )
          )
        )
        .with({ key: { rightArrow: true } }, () =>
          dispatch(
            setLogViewerHorizontalOffset(
              nextColumnOffset(
                columnBoundaries,
                viewer.horizontalOffset,
                LogViewerPanel.HorizontalStep
              )
            )
          )
        )
        .with({ input: LogViewerPanel.JumpTopKey }, () =>
          dispatch(setLogViewerOffset(0))
        )
        .with({ input: LogViewerPanel.JumpBottomKey }, () =>
          dispatch(
            setLogViewerOffset(Math.max(0, runtime.totalLines - viewportHeight))
          )
        )
        .with({ input: LogViewerPanel.FollowKey }, () =>
          dispatch(setLogViewerFollow(true))
        )
        .with(
          { input: LogViewerPanel.SearchKey, key: { ctrl: true } },
          () => dispatch(setSearchActive(true))
        )
        .with({ input: LogViewerPanel.ToggleLocationKey }, () =>
          dispatch(toggleLocationColumn())
        )
        .with({ key: { escape: true } }, () => dismiss())
        .otherwise(() => {})
    },
    { isActive: isFocused && !viewer.searchActive }
  )

  const borderColor = isFocused
    ? LogViewerPanel.BorderColorFocused
    : LogViewerPanel.BorderColorUnfocused

  if (!viewer.path) {
    return (
      <Box
        flexDirection="column"
        borderStyle={LogViewerPanel.BorderStyle}
        borderColor={borderColor}
        paddingX={1}
      >
        <Text dimColor>{LogViewerPanel.EmptySelectionText}</Text>
      </Box>
    )
  }
  if (runtime.indexing) {
    return (
      <Box
        flexDirection="column"
        borderStyle={LogViewerPanel.BorderStyle}
        borderColor={borderColor}
        paddingX={1}
      >
        <Text dimColor>
          {LogViewerPanel.IndexingPrefix}
          {viewer.path}...
        </Text>
      </Box>
    )
  }

  const isJsonl = viewer.path.endsWith(PidSources.JsonlExt)

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle={LogViewerPanel.BorderStyle}
      borderColor={borderColor}
      paddingX={1}
    >
      <Text dimColor wrap={LineRender.TruncateMode}>
        {viewer.path} — line {effectiveOffset + 1} of {runtime.totalLines}
        {viewer.follow ? LogViewerPanel.FollowFlag : ""}
        {isJsonl ? LogViewerPanel.JsonlFlag : ""}
        {viewer.searchQuery
          ? `${LogViewerPanel.SearchPrefix}${viewer.searchQuery}${LogViewerPanel.SearchSuffix}`
          : ""}
        {"  "}
        {LogViewerPanel.HelpText}
      </Text>
      <VirtualList
        totalItems={runtime.totalLines}
        offset={effectiveOffset}
        viewportHeight={viewportHeight}
        fetchRange={fetchRange}
        renderItem={(line, i) =>
          isJsonl ? (
            <LogViewerJSONLine
              key={i}
              line={line}
              horizontalOffset={viewer.horizontalOffset}
              highlight={viewer.searchQuery}
              locationVisible={viewer.locationVisible}
            />
          ) : (
            <LogViewerTextLine
              key={i}
              line={line}
              horizontalOffset={viewer.horizontalOffset}
              highlight={viewer.searchQuery}
            />
          )
        }
      />
      {viewer.searchActive && (
        <LogViewerSearchInput
          initialQuery={viewer.searchQuery}
          onSubmit={q => void findNext(q)}
          onClose={() => dispatch(setSearchActive(false))}
        />
      )}
    </Box>
  )
}

/** Virtual log viewer — offset-controlled window, backed by `LogTailingService`. */
export function LogViewerPanel(props: PanelComponentProps) {
  return <LogViewerBody {...props} />
}

export namespace LogViewerPanel {
  /** Stable id for `useFocus` and the panel registry. */
  export const id = "process-monitor:log-viewer" as const
  /** Display title rendered by parent panels / status bars. */
  export const title = "Log Viewer" as const
  /** Focus id of the parent panel — Esc returns control here. */
  export const ParentFocusId = "process-monitor:panel" as const
  /** Border style around the panel. */
  export const BorderStyle = "round" as const
  /** Border color while focused — draws the eye. */
  export const BorderColorFocused = "cyan" as const
  /** Border color while unfocused — keeps the chrome present but quiet. */
  export const BorderColorUnfocused = "gray" as const
  /**
   * Non-content rows subtracted from terminal height when computing viewport
   * height. Accounts for: App outer border (2) + padding (2) + header (2) +
   * marginTop above body (1) + marginTop above status (1) + status (1) +
   * compact ProcessMonitorPanel (5) + marginTop between panels (1) +
   * LogViewerPanel border (2) + LogViewerPanel status row (1) = 18.
   * Keeping the panel-internal status as a fixed row means the VirtualList's
   * requested height never overshoots the bordered Box's actual rows.
   */
  export const ChromeLines = 18
  /** Extra rows consumed by the search input when `searchActive` is true (marginTop + 1 line). */
  export const SearchInputRows = 2
  /** Floor for `viewportHeight` — keeps at least a few lines visible on tiny terminals. */
  export const MinViewportHeight = 3
  /** Fallback step (in chars) once horizontal pan reaches the last column boundary. */
  export const HorizontalStep = 8
  /** Empty boundary set used in plain-text mode — every press falls back to `HorizontalStep`. */
  export const NoColumnBoundaries: readonly number[] = []
  /** How many lines the find-next scanner reads per `tailing.readWindow` call. */
  export const SearchChunkLines = 200
  /** Key that jumps to line 0. */
  export const JumpTopKey = "g" as const
  /** Key that jumps to the tail-minus-viewport offset. */
  export const JumpBottomKey = "G" as const
  /** Key that re-enables follow mode. */
  export const FollowKey = "F" as const
  /** Lowercase 'f' (combined with Ctrl) opens the search input. */
  export const SearchKey = "f" as const
  /** Toggle the JSONL `location` column (sticky across selections). */
  export const ToggleLocationKey = "l" as const
  /** Status-line flag rendered while `viewer.follow` is true. */
  export const FollowFlag = " [FOLLOW]" as const
  /** Status-line flag rendered while the active path is a JSONL file. */
  export const JsonlFlag = " [JSONL]" as const
  /** Prefix for the active-search status fragment. */
  export const SearchPrefix = " [search: " as const
  /** Suffix for the active-search status fragment. */
  export const SearchSuffix = "]" as const
  /** Empty-state copy when no log path is selected. */
  export const EmptySelectionText =
    "Select a node in the Process Monitor panel (Enter) to view its log." as const
  /** Prefix shown while the line index is being built. */
  export const IndexingPrefix = "Indexing " as const
  /** Hint string rendered at the right end of the status line. */
  export const HelpText =
    "[↑/↓ scroll, ←/→ pan, PgUp/PgDn page, g/G top/bot, F follow, Ctrl+F search, L location]" as const
}
