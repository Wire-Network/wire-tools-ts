import React, { useEffect, useState } from "react"
import { Box, Text, useFocus, useFocusManager, useInput, useWindowSize } from "ink"
import { match } from "ts-pattern"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type { PanelComponentProps } from "../../../components/PanelComponent.js"
import { adjustStickyWindow } from "../../../components/stickyWindow.js"
import { useRouter } from "../../../router/index.js"
import { useService } from "../../../services/ServiceContext.js"
import { ServiceId } from "../../../services/ServiceId.js"
import { useAppSelector } from "../../../store/Store.js"
import {
  selectAllEpochsDescending,
  selectOldestEpochIndex
} from "../../../store/opp/OPPSelectors.js"
import { OPPTrackingService } from "../OPPTrackingService.js"
import type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "../../../store/opp/OPPTypes.js"
import {
  EndpointTypeNames,
  attestationCountFor,
  epochUpdatedAt,
  indexEnvelopesByEndpoint,
  isEpochComplete
} from "../util/EpochSummary.js"

/** Compact 7-char abbreviation of an `OUTPOST_X_DEPOT` / `DEPOT_OUTPOST_X` name. */
function shortEndpointName(name: string): string {
  return match(name)
    .with("OUTPOST_ETHEREUM_DEPOT", () => "OUT_ETH")
    .with("OUTPOST_SOLANA_DEPOT", () => "OUT_SOL")
    .with("DEPOT_OUTPOST_ETHEREUM", () => "DEP_ETH")
    .with("DEPOT_OUTPOST_SOLANA", () => "DEP_SOL")
    .otherwise(n => n.slice(0, EpochTrackerPanel.EndpointHeaderWidth))
}

/** Format an updated-at Unix-ms as `HH:mm:ss.SSS`. */
function formatUpdatedAt(ms: number | null): string {
  if (ms === null) return "—"
  const d = new Date(ms)
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0")
  ].join(":") + "." + String(d.getMilliseconds()).padStart(3, "0")
}

/**
 * Two-row cell for one (epoch, endpoint) pair. The first row is the status
 * icon (✅ delivered, Nerd-Font progress-clock for pending), the second
 * row is the `#N attestations` label when delivered. Pending cells render
 * the icon row only — the second row stays blank so column heights still
 * line up across the table.
 */
function EndpointCell(props: {
  env: DebugOPPEnvelopeRecord | undefined
  isLatest: boolean
}): React.ReactElement {
  const { env, isLatest } = props
  if (env) {
    const count = attestationCountFor(env.envelope)
    return (
      <Box
        flexDirection="column"
        width={EpochTrackerPanel.EndpointCellWidth}
        alignItems="center"
      >
        <Text color={EpochTrackerPanel.ReceivedColor}>
          {EpochTrackerPanel.ReceivedIcon}
        </Text>
        <Text>
          #{count} {EpochTrackerPanel.AttestationsLabel}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      flexDirection="column"
      width={EpochTrackerPanel.EndpointCellWidth}
      alignItems="center"
    >
      <Text
        color={
          isLatest
            ? EpochTrackerPanel.PendingColor
            : EpochTrackerPanel.MissingColor
        }
      >
        {EpochTrackerPanel.PendingIcon}
      </Text>
      <Text> </Text>
    </Box>
  )
}

/**
 * Column-title row drawn once above the epoch list. Each cell width must
 * match the row body's so the columns align.
 */
function HeaderRow(): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box width={EpochTrackerPanel.EpochColumnWidth}>
        <Text bold>epoch</Text>
      </Box>
      <Box width={EpochTrackerPanel.UpdatedColumnWidth}>
        <Text bold>updated</Text>
      </Box>
      {EndpointTypeNames.map(name => (
        <Box
          key={name}
          width={EpochTrackerPanel.EndpointCellWidth}
          alignItems="center"
        >
          <Text bold>{shortEndpointName(name)}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** Body of a single epoch row — epoch + updated + endpoint cells. */
function EpochRowBody(props: {
  record: DebugOPPEpochRecord
  isLatest: boolean
  isSelected: boolean
}): React.ReactElement {
  const { record, isLatest, isSelected } = props,
    byEndpoint = indexEnvelopesByEndpoint(record),
    selectionMarker = isSelected
      ? EpochTrackerPanel.SelectionMarker
      : EpochTrackerPanel.SelectionPlaceholder
  return (
    <Box flexDirection="row">
      <Box width={EpochTrackerPanel.EpochColumnWidth}>
        <Text inverse={isSelected} bold={isLatest}>
          {selectionMarker} {record.epoch}
        </Text>
      </Box>
      <Box width={EpochTrackerPanel.UpdatedColumnWidth}>
        <Text inverse={isSelected} dimColor={!isLatest}>
          {formatUpdatedAt(epochUpdatedAt(record))}
        </Text>
      </Box>
      {EndpointTypeNames.map(name => (
        <EndpointCell
          key={name}
          env={byEndpoint.get(name)}
          isLatest={isLatest}
        />
      ))}
    </Box>
  )
}

/**
 * One scrollable item — the bordered shell. Rules:
 *
 *   - LATEST row → yellow (incomplete) / green (complete) round border.
 *   - SELECTED non-latest → cyan round border (decoration; doesn't change
 *     column geometry because non-bordered rows compensate with `paddingX=2`).
 *   - Otherwise → no border, `paddingX=2` so the row content aligns with
 *     the bordered rows above/below it (`border(1) + paddingX(1) = 2`).
 *
 * `marginTop` is 1 between non-adjacent-to-border rows and 0 wherever a
 * visible border already provides the visual separator.
 */
function EpochRow(props: {
  record: DebugOPPEpochRecord
  isLatest: boolean
  isSelected: boolean
  marginTop: number
}): React.ReactElement {
  const { record, isLatest, isSelected, marginTop } = props,
    visibleBorder = isLatest || isSelected
  if (visibleBorder) {
    const borderColor = isLatest
      ? isEpochComplete(record)
        ? EpochTrackerPanel.ReceivedColor
        : EpochTrackerPanel.PendingColor
      : EpochTrackerPanel.SelectedBorderColor
    return (
      <Box
        flexDirection="column"
        marginTop={marginTop}
        borderStyle={EpochTrackerPanel.LatestBorderStyle}
        borderColor={borderColor}
        paddingX={1}
      >
        <EpochRowBody
          record={record}
          isLatest={isLatest}
          isSelected={isSelected}
        />
      </Box>
    )
  }
  return (
    <Box
      flexDirection="column"
      marginTop={marginTop}
      paddingX={EpochTrackerPanel.UnborderedPaddingX}
    >
      <EpochRowBody
        record={record}
        isLatest={isLatest}
        isSelected={isSelected}
      />
    </Box>
  )
}

function EpochTrackerBody(_: PanelComponentProps): React.ReactElement {
  const epochs = useAppSelector(selectAllEpochsDescending),
    oldestEpoch = useAppSelector(selectOldestEpochIndex),
    tracking = useService<OPPTrackingService>(ServiceId.OPPTracking),
    { rows } = useWindowSize(),
    router = useRouter(),
    { isFocused } = useFocus({
      autoFocus: true,
      id: EpochTrackerPanel.id
    }),
    { focus: _focus } = useFocusManager(),
    [selectedEpoch, setSelectedEpoch] = useState<number | null>(null),
    [sliceStart, setSliceStart] = useState(0),
    [loadingOlder, setLoadingOlder] = useState(false),
    [olderExhausted, setOlderExhausted] = useState(false)

  const cursorByLabel =
      selectedEpoch === null
        ? -1
        : epochs.findIndex(e => e.epoch === selectedEpoch),
    safeCursorIdx =
      cursorByLabel === -1 || cursorByLabel >= epochs.length ? 0 : cursorByLabel

  // Approximate visual rows-per-epoch — bordered rows take 2 content rows +
  // 2 border rows; non-bordered rows take 2 content rows + 1 margin row.
  const visibleCount = computeVisibleCount(rows)

  // Sticky window: keep `sliceStart` parked unless the cursor leaves the
  // visible range, OR the underlying list shrunk below the current viewport.
  // Without this the window re-centered on every keystroke and the rows
  // visibly slid past a fixed cursor position.
  useEffect(() => {
    setSliceStart(prev =>
      adjustStickyWindow(prev, safeCursorIdx, epochs.length, visibleCount)
    )
  }, [safeCursorIdx, epochs.length, visibleCount])

  const visibleEpochs = epochs.slice(sliceStart, sliceStart + visibleCount)

  const move = React.useCallback(
    (delta: number) => {
      if (epochs.length === 0) return
      const nextIdx = Math.max(
        0,
        Math.min(epochs.length - 1, safeCursorIdx + delta)
      )
      setSelectedEpoch(epochs[nextIdx].epoch)
    },
    [epochs, safeCursorIdx]
  )

  const loadOlder = React.useCallback(async () => {
    if (loadingOlder || olderExhausted) return
    if (oldestEpoch === null || oldestEpoch <= 0) {
      setOlderExhausted(true)
      return
    }
    setLoadingOlder(true)
    try {
      const lowest = await tracking.loadOlder(oldestEpoch)
      if (lowest === null) setOlderExhausted(true)
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder, olderExhausted, oldestEpoch, tracking])

  useInput(
    (input, key) => {
      if (epochs.length === 0) return
      match({ input, key })
        .with({ key: { upArrow: true } }, () => move(-1))
        .with({ input: "k" }, () => move(-1))
        .with({ key: { downArrow: true } }, () => move(1))
        .with({ input: "j" }, () => move(1))
        .with({ input: "<" }, () => void loadOlder())
        .with({ input: "[" }, () => void loadOlder())
        .with({ key: { return: true } }, () =>
          router.push(EpochTrackerPanel.DetailRoutePath, {
            epoch: String(epochs[safeCursorIdx].epoch)
          })
        )
        .with({ input: "\r" }, () =>
          router.push(EpochTrackerPanel.DetailRoutePath, {
            epoch: String(epochs[safeCursorIdx].epoch)
          })
        )
        .otherwise(() => {})
    },
    { isActive: isFocused }
  )

  if (epochs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{EpochTrackerPanel.EmptyText}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color={isFocused ? "cyan" : undefined}>
        {epochs.length} epoch(s) cached — ↑/↓ select, Enter for detail
        {olderExhausted
          ? "  ·  no older epochs"
          : loadingOlder
            ? "  ·  loading older…"
            : "  ·  < or [ to load older"}
        {isFocused ? "" : "  (Tab to focus)"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <HeaderRow />
        {visibleEpochs.map((rec, i) => {
          const absoluteIdx = sliceStart + i,
            isLatest = absoluteIdx === 0,
            isSelected = absoluteIdx === safeCursorIdx,
            marginTop = computeMarginTop(absoluteIdx, safeCursorIdx, i)
          return (
            <EpochRow
              key={rec.epoch}
              record={rec}
              isLatest={isLatest}
              isSelected={isSelected}
              marginTop={marginTop}
            />
          )
        })}
      </Box>
    </Box>
  )
}

/**
 * Apply the user's margin rule:
 *   "margin of 1 above each row, EXCEPT where there is a border because the
 *    row is selected, latest, or neighboring one of those — the border is
 *    its own visual separator."
 *
 * @param absoluteIdx Index in the descending epoch list.
 * @param selectedIdx Index of the currently-selected row.
 * @param visibleIdx  Index inside the visible viewport (0 ⇒ top of viewport, no top margin).
 */
export function computeMarginTop(
  absoluteIdx: number,
  selectedIdx: number,
  visibleIdx: number
): number {
  if (visibleIdx === 0) return 0
  const hasBorder = (idx: number): boolean => idx === 0 || idx === selectedIdx
  return hasBorder(absoluteIdx) || hasBorder(absoluteIdx - 1) ? 0 : 1
}

/**
 * How many epoch rows can the panel show given `terminalRows` total height.
 * Each row averages 3 visual rows (icon + count + spacer/border); plus the
 * fixed chrome the header + spacer + status bar consume.
 */
function computeVisibleCount(terminalRows: number): number {
  const usable = Math.max(
    EpochTrackerPanel.RowsPerEpoch,
    terminalRows - EpochTrackerPanel.ChromeLines
  )
  return Math.max(
    1,
    Math.floor(usable / EpochTrackerPanel.RowsPerEpoch)
  )
}

/** Panel — virtual list of cached epochs (newest first) with per-endpoint status. */
export function EpochTrackerPanel(props: PanelComponentProps) {
  return <EpochTrackerBody {...props} />
}
EpochTrackerPanel.id = "opp:epoch-tracker" as const
EpochTrackerPanel.title = "OPP — Epoch Tracker" as const

export namespace EpochTrackerPanel {
  /** Width of the epoch-number column. */
  export const EpochColumnWidth = 9
  /** Width of the `updated` column (HH:mm:ss.SSS + 1 space). */
  export const UpdatedColumnWidth = 14
  /** Width of one endpoint cell — fits `#NNN attestations` (≤17 chars) + 1 char padding. */
  export const EndpointCellWidth = 18
  /** Width budgeted for the abbreviated endpoint name in headers. */
  export const EndpointHeaderWidth = 7
  /**
   * Average visual rows consumed by one epoch row when sized for viewport
   * math: 2 rows of content + ~1 row of separator (border line on bordered
   * rows, marginTop on non-bordered).
   */
  export const RowsPerEpoch = 3
  /** Approximate non-list rows subtracted from the panel's available height. */
  export const ChromeLines = 6
  /** Border style for the visible-bordered rows (selected / latest). */
  export const LatestBorderStyle = "round" as const
  /** Color used for received envelopes / completed-epoch borders. */
  export const ReceivedColor = "green" as const
  /** Color for the in-flight (current-epoch, awaiting envelope) icon + border. */
  export const PendingColor = "yellow" as const
  /** Color for any historical missing-envelope cells (shouldn't normally occur). */
  export const MissingColor = "gray" as const
  /** Border color for the cursor-selected row when it's not also the latest. */
  export const SelectedBorderColor = "cyan" as const
  /**
   * `paddingX` applied to non-bordered rows so their content lines up with
   * bordered rows (which have `border(1) + paddingX(1) = 2` of horizontal
   * inset). Adjust both together if `LatestBorderStyle` ever changes width.
   */
  export const UnborderedPaddingX = 2
  /** Glyph rendered when an envelope has arrived for this (epoch, endpoint). */
  export const ReceivedIcon = "\u{2705}" as const
  /** Nerd-Font progress-clock glyph for an in-flight (not yet received) cell. */
  export const PendingIcon = "\u{F04E6}" as const
  /** Suffix on the per-cell delivered count — full word per the spec. */
  export const AttestationsLabel = "attestations" as const
  /** Marker prefix on the selected row. */
  export const SelectionMarker = "›" as const
  /** Same width as `SelectionMarker` so column widths don't shift between rows. */
  export const SelectionPlaceholder = " " as const
  /** Path of the EpochDetailRoute pushed when Enter is pressed. */
  export const DetailRoutePath = "/opp/epoch" as const
  /** Empty-state copy when no envelopes have been cached yet. */
  export const EmptyText =
    "No epochs cached yet — waiting for the first envelope file..." as const
}
