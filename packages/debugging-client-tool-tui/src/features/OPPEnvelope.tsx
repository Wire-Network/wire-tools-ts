import React from "react"
import { Box, Text } from "ink"
import { useSelector } from "react-redux"

import { Panel } from "../components/Panel.js"
import { StatusWidget } from "../components/StatusWidget.js"
import type { ComponentProviders } from "../providers/ComponentProviders.js"
import { FeatureDebugger } from "./FeatureDebugger.js"
import { selectCluster } from "../store.js"

// ---------------------------------------------------------------------------
//  Envelope exchanges — one per outpost endpoint participating in an epoch.
// ---------------------------------------------------------------------------

/**
 * The four OPP envelope exchanges sampled per epoch. The stub tracker
 * renders one row per entry — real data lands when we wire up the
 * DebuggingServer client.
 */
export namespace OPPEnvelope {
  export const Id = "opp-envelope" as const
  export const Name = "OPP Envelope" as const

  /** Canonical order of the four per-epoch envelope exchanges. */
  export const ExchangeSlots = [
    "outpost_ethereum_depot",
    "outpost_ethereum_reserve",
    "outpost_solana_depot",
    "outpost_solana_reserve"
  ] as const

  export type ExchangeSlot = (typeof ExchangeSlots)[number]
}

// ---------------------------------------------------------------------------
//  Epoch tracker panel — one widget row per envelope exchange slot.
// ---------------------------------------------------------------------------

function EpochTrackerBody(): React.ReactElement {
  const cluster = useSelector(selectCluster)
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
            <Box width={32}>
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
