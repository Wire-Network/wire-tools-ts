import { z } from "zod"

import { QueryEngineReadModeSchema, SchemaCodec } from "@wireio/cluster-tool-shared"

import type { CellValue } from "../values/CellValue.js"
import { LogicalType } from "./LogicalType.js"
import { QueryEngineRPC } from "./QueryEngineRPC.js"
import { QueryResultPatterns } from "./QueryResultPatterns.js"
import { QueryResultShape } from "./QueryResultShape.js"
import { ValueEncoding } from "./ValueEncoding.js"

/** An unsigned decimal-string counter. */
const UnsignedDecimalSchema = z.string().regex(QueryResultPatterns.UnsignedDecimal)

/** One result column's metadata (`columns[]`). */
export const QueryColumnSchema = z.strictObject({
  name: z.string(),
  logical_type: z.enum(LogicalType),
  abi_type: z.string().nullable(),
  nullable: z.boolean(),
  encoding: z.enum(ValueEncoding)
})

/** `source` — owners + table the result was read from. */
export const QuerySourceSchema = z.strictObject({
  owners: z.array(z.string()).min(1),
  table: z.string().min(1)
})

/** One `state.abis[]` entry. */
export const QueryAbiReferenceSchema = z.strictObject({
  owner: z.string(),
  hash: z.string()
})

/** `state` — the single block snapshot the result reflects. */
export const QueryStateSchema = z.strictObject({
  chain_id: z.string(),
  block_id: z.string(),
  block_num: UnsignedDecimalSchema,
  block_time: z.string(),
  read_mode: QueryEngineReadModeSchema,
  last_irreversible_block_num: UnsignedDecimalSchema,
  abis: z.array(QueryAbiReferenceSchema),
  captured_at: z.string(),
  synced: z.boolean()
})

/** `stats` — engine work counters (decimal strings). */
export const QueryStatsSchema = z.strictObject({
  scanned_rows: UnsignedDecimalSchema,
  matched_rows: UnsignedDecimalSchema,
  groups: UnsignedDecimalSchema,
  returned_rows: UnsignedDecimalSchema,
  raw_bytes: UnsignedDecimalSchema,
  elapsed_us: UnsignedDecimalSchema
})

/** `result.page` — the window this response covers over the COMPLETE evaluated output. */
export const QueryPageSchema = z.strictObject({
  /** Rows skipped (the requested offset). */
  offset: UnsignedDecimalSchema,
  /** min(SQL LIMIT, request limit); null when neither was given. */
  limit: UnsignedDecimalSchema.nullable(),
  /** Rows in this page. */
  returned_rows: UnsignedDecimalSchema,
  /** Output rows after WHERE / GROUP BY / HAVING (detail: matching rows; grouped: groups passing HAVING). */
  total_rows: UnsignedDecimalSchema,
  /** More rows exist beyond this window. */
  has_more: z.boolean()
})

/** One page descriptor. */
export type QueryPage = z.infer<typeof QueryPageSchema>

/** A successful `query.execute` result — required keys mirror `query-response.schema.json` `result.required`. */
export const QueryResultSchema = z
  .strictObject({
    schema_version: z.literal(QueryEngineRPC.SchemaVersion),
    complete: z.literal(true),
    source: QuerySourceSchema,
    state: QueryStateSchema,
    columns: z.array(QueryColumnSchema).min(1),
    // Shallow: each row is a record of CellValue (typed, not checked deeply); the
    // key set is checked against columns in ONE pass by QueryResultShape; deep
    // cell shape is asserted lazily by CellFormatter.
    rows: z.array(z.record(z.string(), z.custom<CellValue>())),
    stats: QueryStatsSchema,
    page: QueryPageSchema
  })
  .superRefine(QueryResultShape.refineRowKeys)

/** One result column. */
export type QueryColumn = z.infer<typeof QueryColumnSchema>
/** `source` of a result. */
export type QuerySource = z.infer<typeof QuerySourceSchema>
/** `state` of a result. */
export type QueryState = z.infer<typeof QueryStateSchema>
/** `stats` of a result. */
export type QueryStats = z.infer<typeof QueryStatsSchema>
/** One engine result. */
export type QueryResult = z.infer<typeof QueryResultSchema>
/** One row — cells keyed by column name. */
export type QueryRow = QueryResult["rows"][number]

/** Validating codec for {@link QueryResultSchema}. */
export const QueryResultCodec = SchemaCodec.create<QueryResult>(QueryResultSchema)
