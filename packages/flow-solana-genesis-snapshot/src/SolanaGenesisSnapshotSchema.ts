import { z } from "zod"

const amount = z.string().regex(/^\d+$/)

/** External capital-index artifact contract; the flow never imports its calculation code. */
export const SolanaGenesisSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  programId: z.string(),
  allocationHash: z.string().regex(/^[a-f0-9]{64}$/),
  balances: z.array(
    z.object({
      address: z.string(),
      outpostAccount: z.string().nullable(),
      pretokenRecord: z.string().nullable(),
      syndicatedLiqsol: amount,
      purchasedLiqsol: amount,
      stakedShares: amount,
      purchasedShares: amount,
      directlyPurchasedPretokens: amount,
      pretokenYield: amount,
      totalPretokens: amount
    })
  ),
  accounting: z
    .object({
      wireState: z.literal("Launching"),
      mode: z.literal("genesis"),
      epoch: amount,
      poolAuthority: z.string(),
      poolBalance: amount,
      poolPretokens: amount,
      allocatedPretokenYield: amount,
      unallocatedPoolPretokens: amount,
      directlyPurchasedPretokens: amount,
      totalUserPretokens: amount,
      totalPretokensSold: amount,
      ownerlessShares: amount,
      unreportedLiqsolYield: amount,
      backingAvailable: amount,
      maxInitialChainAmount: amount,
      issues: z.array(z.string()),
      units: z.object({
        liqsolDecimals: z.literal(9),
        pretokenDecimals: z.literal(8),
        indexScale: z.literal("1000000000000")
      })
    })
    .passthrough(),
  evidence: z
    .array(
      z.object({
        address: z.string(),
        owner: z.string(),
        slot: z.number().int(),
        dataBase64: z.string()
      })
    )
    .nonempty()
})

/** Validated external snapshot document returned by capital-index. */
export type SolanaGenesisSnapshot = z.infer<typeof SolanaGenesisSnapshotSchema>
