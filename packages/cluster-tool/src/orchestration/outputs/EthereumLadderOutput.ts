import type { EthereumLadderSummary } from "@wireio/cluster-tool-shared"
import type { SysioContracts } from "@wireio/sdk-core"
import type { OppSnapshot } from "@wireio/opp-snapshot"
import { outputKey } from "../OutputStore.js"

/** The ladder's books and rung, as `deployLadder.ts` summarized them. */
export const EthereumLadderSummaryKey = outputKey<EthereumLadderSummary>(
  "ethereumLadder.summary",
  "the pre-launch outpost's books and the rung the ladder stopped before"
)

/**
 * `Depositor.lastPoolLiqBalance` as the deep freeze recorded it, in liqETH's
 * native 18-decimal frame: the booked figure the depot bootstrap is built from
 * and the go-live seeds the pool with.
 */
export const EthereumBookedFigureKey = outputKey<bigint>(
  "ethereumLadder.bookedFigure",
  "the frozen Depositor's lastPoolLiqBalance, in wei"
)

/**
 * What the frozen outpost imports into the depot, derived from the
 * capital-index snapshot and the booked figure: the syndication credits
 * (one per staker, keyed by pubkey, in the depot frame), the LCO shadow the
 * pool is registered with (the booked custody net of those credits — the
 * dust the flooring drops lands there), and the dclaim seed batches.
 */
export interface EthereumLadderImport {
  /** The booked figure in the depot's nine-decimal frame. */
  readonly bookedDepotUnits: bigint
  /** `sysio.synd::importsynd` credits, one per staker. */
  readonly credits: SysioContracts.SysioSyndImportCreditType[]
  /** `sysio.liq::regliqpool`'s `initial_chain_amount`: the booked figure minus the credits. */
  readonly initialChainAmount: bigint
  /** `sysio.dclaim::importseed` batches, clio-ready. */
  readonly importseed: SysioContracts.SysioDclaimImportseedAction[]
  /** Total WIRE atomic the dclaim batches credit. */
  readonly importseedTotalAtomic: bigint
}

/** The frozen outpost's OPP balance snapshot, as the capital indexer computes it (`@wireio/opp-snapshot`). */
export const CapitalIndexSnapshotKey = outputKey<OppSnapshot>(
  "ethereumLadder.capitalIndexSnapshot",
  "the frozen outpost's staker and purchaser balances"
)

/** The depot import derived from the snapshot and the booked figure. */
export const EthereumLadderImportKey = outputKey<EthereumLadderImport>(
  "ethereumLadder.import",
  "the syndication credits, the pool's shadow seed and the dclaim batches"
)
