import { z } from "zod"

import { SolanaAddressPattern } from "./chainAddressPatterns.js"

/**
 * One deployed SPL mint — a row of a cluster's `sol-mock-mints.json`: the
 * packed token slug `code` (`SlugName.from(<codename>)`), the base58 `mint`
 * address and the mint's `decimals`. A local Solana outpost deploy writes these
 * rows; an external-outpost config supplies them for the outpost's real mints.
 */
export const SolanaMintRecordSchema = z.strictObject({
  /** The packed token slug code (`SlugName.from(<codename>)`). */
  code: z.number().int().nonnegative(),
  /** The mint address (base58 public key). */
  mint: z.string().regex(SolanaAddressPattern),
  /** The mint's decimals. */
  decimals: z.number().int().nonnegative()
})
/** One deployed SPL mint — the shape of {@link SolanaMintRecordSchema}. */
export type SolanaMintRecord = z.infer<typeof SolanaMintRecordSchema>
