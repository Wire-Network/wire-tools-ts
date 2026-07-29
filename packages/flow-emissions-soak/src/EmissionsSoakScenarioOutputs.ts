import { outputKey } from "@wireio/cluster-tool"
import type { ControlledStakerIdentity } from "./EmissionsSoakScenarioSyntheticDump.js"

/**
 * Per-controlled-staker obligations derived from the final merged generic
 * bootstrap result, including configured-file credits at colliding addresses.
 */
export interface ControlledClaimExpectations {
  /** Expected WIRE-atomic payout keyed by controlled WIRE account. */
  readonly creditsByWireAccount: Readonly<Record<string, bigint>>
  /** Aggregate amount transferred to `sysio.dclaim` before claims. */
  readonly preFundAtomic: bigint
}

/** The controlled-staker roster every claimer and verification Step reads. */
export const ClaimantIdentitiesKey = outputKey<
  readonly ControlledStakerIdentity[]
>(
  "emissions-soak:claimant-identities",
  "controlled-staker identities (WIRE account, ETH address, HD index)"
)

/** Final per-address claim expectations and their aggregate pre-fund amount. */
export const ControlledClaimExpectationsKey =
  outputKey<ControlledClaimExpectations>(
    "emissions-soak:controlled-claim-expectations",
    "controlled claim payouts derived from the final merged dclaim bootstrap"
  )

/** Per-account WIRE balances (raw 9-decimal atomic) snapshotted pre-claim. */
export const PreClaimBalancesKey = outputKey<Readonly<Record<string, bigint>>>(
  "emissions-soak:preclaim-balances",
  "controlled stakers' WIRE balances before their dclaim claims"
)
