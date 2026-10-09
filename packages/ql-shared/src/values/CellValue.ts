import { z } from "zod"

import { QueryResultPatterns } from "../protocol/QueryResultPatterns.js"

/** One engine cell (numbers are decimal STRINGS; containers project losslessly). */
export type CellValue = null | boolean | string | CellValue[] | CellRecord

/** A nested object cell. */
export interface CellRecord {
  [field: string]: CellValue
}

/** Asset cell (`asset_object` encoding); `contract` is present on extended assets. */
export const AssetCellSchema = z.object({
  /** Decimal-string amount (already scaled; may carry fewer fraction digits than `precision`). */
  amount: z.string().regex(QueryResultPatterns.SignedDecimal),
  /** Token symbol code. */
  symbol: z.string(),
  /** Decimal-string precision (fraction digits). */
  precision: z.string().regex(QueryResultPatterns.UnsignedDecimal),
  /** Issuing contract (extended assets only). */
  contract: z.string().optional()
})

/** Asset cell (`asset_object` encoding) — the shape of {@link AssetCellSchema}. */
export type AssetCell = z.infer<typeof AssetCellSchema>
