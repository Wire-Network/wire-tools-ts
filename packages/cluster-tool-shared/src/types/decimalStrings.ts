import { z } from "zod"

/** An unsigned decimal integer — digits only, no sign, point or exponent. */
export const UnsignedDecimalPattern = /^\d+$/

/**
 * An unsigned integer carried as a JSON decimal string, the encoding exported chain
 * balances use so values past `Number.MAX_SAFE_INTEGER` survive JSON.
 */
export const UnsignedDecimalStringSchema = z
  .string()
  .regex(UnsignedDecimalPattern)
