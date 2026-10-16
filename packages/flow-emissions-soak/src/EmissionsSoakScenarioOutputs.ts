import { outputKey } from "@wireio/cluster-tool"

/** Per-account WIRE balances (raw 9-decimal atomic) snapshotted pre-claim. */
export const PreClaimBalancesKey = outputKey<Record<string, bigint>>(
  "emissions-soak:preclaim-balances",
  "The claimants' WIRE balances before their dclaim claims"
)
