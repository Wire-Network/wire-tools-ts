import { Asset } from "@wireio/sdk-core"

/**
 * Parse ABI asset base units without a floating-point conversion.
 * @param quantity - ABI asset string, including precision and symbol.
 * @returns The exact signed integer amount.
 */
export function assetUnits(quantity: string): bigint {
  return BigInt(Asset.from(quantity).units.toString())
}
