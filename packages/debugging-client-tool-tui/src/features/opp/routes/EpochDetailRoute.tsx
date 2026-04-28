import React, { useMemo, useState } from "react"
import { Box, Text, useFocus, useInput } from "ink"
import { match } from "ts-pattern"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type { RouteComponentProps } from "../../../router/RouteTypes.js"
import { useAppSelector } from "../../../store/Store.js"
import { selectEpochByNumber } from "../../../store/opp/OPPSelectors.js"
import type { DebugOPPEnvelopeRecord } from "../../../store/opp/OPPTypes.js"
import {
  EnvelopeDetailView,
  flattenAttestations
} from "../panels/EnvelopeDetailView.js"
import { EpochDetailOverview } from "../panels/EpochDetailOverview.js"

/**
 * Cached envelope-with-display-label. The detail view iterates these in the
 * declared (filename / endpoint-enum) order so the keyboard navigation order
 * is stable across renders.
 */
interface OrderedEnvelope {
  endpointName: string
  record: DebugOPPEnvelopeRecord
}

/**
 * Stack the route's envelopes by endpoint enum order. Indexing them up front
 * lets ↑/↓ cross envelope boundaries without re-deriving the list every
 * keypress.
 */
function orderEnvelopes(
  envelopes: readonly DebugOPPEnvelopeRecord[]
): OrderedEnvelope[] {
  return envelopes
    .map(record => {
      const endpointName = DebugOutpostEndpointsType[record.endpointsType] as
        | string
        | undefined
      return endpointName ? { endpointName, record } : null
    })
    .filter((v): v is OrderedEnvelope => v !== null)
    .sort((a, b) => a.endpointName.localeCompare(b.endpointName))
}

/**
 * Full-screen detail view for one cached epoch. Layout:
 *
 *   ┌─ overview (static) ─┐   per-endpoint status, total attestations, metadata
 *   ├─ envelope details ──┤   one block per received envelope, accordion JSON
 *   │  (scrollable)       │
 *   └─────────────────────┘
 *
 * Keyboard:
 *   - ↑/↓: move the cursor across envelope rows (crosses envelope boundaries).
 *   - Enter: toggle the accordion JSON for the focused attestation row.
 *   - Esc:  pop back to the tracker (handled at App level).
 */
export function EpochDetailRoute(
  props: RouteComponentProps
): React.ReactElement {
  const epochNum = Number.parseInt(props.params.epoch ?? "", 10),
    record = useAppSelector(selectEpochByNumber(epochNum)),
    ordered = useMemo(
      () => (record ? orderEnvelopes(record.envelopes) : []),
      [record]
    ),
    flatLengths = useMemo(
      () => ordered.map(o => flattenAttestations(o.record.envelope).length),
      [ordered]
    ),
    totalRows = flatLengths.reduce((acc, n) => acc + n, 0),
    [globalCursor, setGlobalCursor] = useState(0),
    [expanded, setExpanded] = useState(false),
    { isFocused } = useFocus({
      autoFocus: true,
      id: EpochDetailRoute.id
    })

  const safeCursor = totalRows === 0 ? 0 : Math.min(globalCursor, totalRows - 1),
    { envelopeIdx, cursorWithin } = locateCursor(flatLengths, safeCursor)

  useInput(
    (input, key) => {
      if (totalRows === 0) return
      match({ input, key })
        .with({ key: { upArrow: true } }, () => {
          setExpanded(false)
          setGlobalCursor(c => Math.max(0, c - 1))
        })
        .with({ input: "k" }, () => {
          setExpanded(false)
          setGlobalCursor(c => Math.max(0, c - 1))
        })
        .with({ key: { downArrow: true } }, () => {
          setExpanded(false)
          setGlobalCursor(c => Math.min(totalRows - 1, c + 1))
        })
        .with({ input: "j" }, () => {
          setExpanded(false)
          setGlobalCursor(c => Math.min(totalRows - 1, c + 1))
        })
        .with({ key: { return: true } }, () => setExpanded(e => !e))
        .with({ input: "\r" }, () => setExpanded(e => !e))
        .otherwise(() => {})
    },
    { isActive: isFocused }
  )

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column">
        <EpochDetailOverview record={record} />
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        marginTop={1}
        borderStyle={EpochDetailRoute.DetailBorderStyle}
        borderColor={
          isFocused
            ? EpochDetailRoute.BorderColorFocused
            : EpochDetailRoute.BorderColorUnfocused
        }
        paddingX={1}
      >
        {ordered.length === 0 ? (
          <Text dimColor>{EpochDetailRoute.NoEnvelopesText}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {totalRows} attestation row(s) — ↑/↓ select, Enter expand/collapse
            </Text>
            {ordered.map((entry, i) => (
              <EnvelopeDetailView
                key={entry.endpointName}
                endpointName={entry.endpointName}
                record={entry.record}
                cursor={i === envelopeIdx ? cursorWithin : null}
                expanded={i === envelopeIdx && expanded}
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

/**
 * Map a global cursor (across every flattened attestation in every envelope)
 * to its `(envelopeIdx, cursorWithin)` pair. Skips empty envelopes — they
 * still appear in the UI but contribute zero rows to the cursor space.
 */
function locateCursor(
  flatLengths: readonly number[],
  global: number
): { envelopeIdx: number; cursorWithin: number } {
  const folded = flatLengths.reduce<{
    envelopeIdx: number
    cursorWithin: number
    remaining: number
  }>(
    (acc, len, i) => {
      if (acc.envelopeIdx !== -1) return acc
      if (acc.remaining < len) {
        return { envelopeIdx: i, cursorWithin: acc.remaining, remaining: 0 }
      }
      return { ...acc, remaining: acc.remaining - len }
    },
    { envelopeIdx: -1, cursorWithin: 0, remaining: global }
  )
  return { envelopeIdx: folded.envelopeIdx, cursorWithin: folded.cursorWithin }
}

export namespace EpochDetailRoute {
  /** Stable focus / route id. */
  export const id = "opp:epoch-detail" as const
  /**
   * Human-readable route name. Capitalized to avoid clashing with
   * `Function.prototype.name` which is non-writable — assigning
   * `EpochDetailRoute.name = ...` would throw at module load.
   */
  export const Name = "OPP Epoch" as const
  /** Path the tracker pushes; param `:epoch` is the absolute epoch number. */
  export const RoutePath = "/opp/epoch" as const
  /** Border style for the scrollable envelope-details container. */
  export const DetailBorderStyle = "round" as const
  /** Border color when the route is focused. */
  export const BorderColorFocused = "cyan" as const
  /** Border color when focus has moved away. */
  export const BorderColorUnfocused = "gray" as const
  /** Empty-state message inside the bordered container. */
  export const NoEnvelopesText =
    "No envelopes have been received for this epoch yet." as const
}
