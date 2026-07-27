import { Base58 } from "@wireio/sdk-core"
import { z } from "zod"

/** Number of raw bytes encoded by a Solana cluster genesis hash. */
export const SolanaGenesisHashByteLength = 32

/**
 * Canonical Base58 encoding of a Solana cluster's 32-byte genesis hash.
 *
 * Fixed-size decoding rejects out-of-range values; re-encoding rejects
 * non-canonical representations such as redundant leading zeroes.
 */
export const SolanaGenesisHashSchema = z.string().superRefine((value, ctx) => {
  try {
    const decoded = Base58.decode(value, SolanaGenesisHashByteLength)
    if (Base58.encode(decoded) !== value) {
      ctx.addIssue({
        code: "custom",
        message: "Solana genesis hash must be canonical Base58"
      })
    }
  } catch {
    ctx.addIssue({
      code: "custom",
      message: `Solana genesis hash must encode exactly ${SolanaGenesisHashByteLength} bytes in Base58`
    })
  }
})

/** A validated Solana cluster genesis hash. */
export type SolanaGenesisHash = z.infer<typeof SolanaGenesisHashSchema>
