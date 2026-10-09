import { Box, Text } from "ink"

import { ResultSummary } from "@wireio/ql-shared"

import { ResultsState, useAppSelector } from "../store/index.js"

/** Separator between connection parts. */
const { Separator } = ResultSummary
/** Characters of the chain id shown. */
const ChainIdPrefixLength = 12
/** Text of a value not yet known (no query has run). */
const UnknownText = "?"

/**
 * The active connection: profile, endpoint, and — from the last result's
 * snapshot — chain id, head / LIB, read mode and sync state.
 *
 * @returns The bar element.
 */
export function ConnectionBar() {
  const profile = useAppSelector(state => state.connection.profile),
    state = useAppSelector(root => ResultsState.success(root.results)?.result.state)
  return (
    <Box>
      <Text>
        <Text bold>{profile?.name ?? UnknownText}</Text>
        <Text dimColor>{`${Separator}${profile?.endpoint ?? UnknownText}`}</Text>
        <Text>
          {state == null
            ? `${Separator}chain ${UnknownText}`
            : [
                "",
                `chain ${state.chain_id.slice(0, ChainIdPrefixLength)}`,
                `head ${state.block_num}`,
                ResultSummary.irreversiblePart(state),
                state.read_mode,
                ResultSummary.syncedLabel(state)
              ].join(Separator)}
        </Text>
      </Text>
    </Box>
  )
}
