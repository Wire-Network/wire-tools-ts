import React from "react"
import { Box, Text } from "ink"

import { Panel } from "../components/Panel.js"
import { StatusWidget } from "../components/StatusWidget.js"
import type { ComponentProviders } from "../providers/ComponentProviders.js"
import { FeatureDebugger } from "./FeatureDebugger.js"
import { selectCluster, useAppSelector } from "../store.js"

// ---------------------------------------------------------------------------
//  Envelope exchanges — one per outpost endpoint participating in an epoch.
// ---------------------------------------------------------------------------

/**
 * The four OPP envelope exchanges sampled per epoch, paired with rendering
 * constants. Real data lands when the DebuggingServer client is wired up.
 */
export namespace OPPEnvelope {
  export const Id = "opp-envelope" as const
  export const Name = "OPP Envelope" as const

  /**
   * Outpost endpoint name exchanged per epoch. Values are the on-wire
   * protocol strings — renaming breaks cross-component correlation with the
   * DebuggingServer's `endpointsType` enum.
   */
  export enum ExchangeSlot {
    EthereumDepot = "outpost_ethereum_depot",
    EthereumReserve = "outpost_ethereum_reserve",
    SolanaDepot = "outpost_solana_depot",
    SolanaReserve = "outpost_solana_reserve"
  }

  /** Iteration order for {@link ExchangeSlot}. Controls UI row ordering. */
  export const ExchangeSlots: readonly ExchangeSlot[] = [
    ExchangeSlot.EthereumDepot,
    ExchangeSlot.EthereumReserve,
    ExchangeSlot.SolanaDepot,
    ExchangeSlot.SolanaReserve
  ]

  /** Column width used for the slot-name column in the epoch tracker. */
  export const SlotColumnWidth = 32
}

// ---------------------------------------------------------------------------
//  Epoch tracker panel — one widget row per envelope exchange slot.
// ---------------------------------------------------------------------------

function EpochTrackerBody(): React.ReactElement {
  const cluster = useAppSelector(selectCluster)
  const epochDurationSec = cluster.config?.epochDurationSec ?? 0

  return (
    <Box flexDirection="column">
      <Text bold>
        Epoch duration: <Text color="cyan">{epochDurationSec}s</Text>
        {"  "}Current epoch: <Text dimColor>?</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {OPPEnvelope.ExchangeSlots.map(slot => (
          <Box key={slot}>
            <Box width={OPPEnvelope.SlotColumnWidth}>
              <Text>{slot}</Text>
            </Box>
            <Text dimColor>envelope: — attestations: —</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** OPP Envelope main panel — per-epoch view with one row per exchange slot. */
class EpochTrackerPanel extends Panel {
  readonly id = EpochTrackerPanel.Id
  readonly title = EpochTrackerPanel.Title
  readonly priority = 50

  render(): React.ReactElement {
    return <EpochTrackerBody />
  }
}

namespace EpochTrackerPanel {
  export const Id = "opp-envelope:epoch-tracker" as const
  export const Title = "OPP Envelope — Epoch Tracker" as const
}

// ---------------------------------------------------------------------------
//  Current-epoch status widget.
// ---------------------------------------------------------------------------

function CurrentEpochBody(): React.ReactElement {
  return (
    <Text>
      epoch: <Text bold>—</Text>
    </Text>
  )
}

class CurrentEpochWidget extends StatusWidget {
  readonly id = CurrentEpochWidget.Id
  readonly priority = 50

  render(): React.ReactElement {
    return <CurrentEpochBody />
  }
}

namespace CurrentEpochWidget {
  export const Id = "opp-envelope:current-epoch" as const
}

// ---------------------------------------------------------------------------
//  Feature debugger
// ---------------------------------------------------------------------------

/**
 * OPP Envelope feature debugger. Registers the epoch-tracker panel and the
 * current-epoch status widget. Populated with real data by a future commit
 * that subscribes to the DebuggingServer's envelope stream.
 */
export class OPPEnvelopeDebugger extends FeatureDebugger {
  readonly id = OPPEnvelope.Id
  readonly name = OPPEnvelope.Name

  register(providers: typeof ComponentProviders): void {
    providers.register(Panel, new EpochTrackerPanel())
    providers.register(StatusWidget, new CurrentEpochWidget())
  }
}
