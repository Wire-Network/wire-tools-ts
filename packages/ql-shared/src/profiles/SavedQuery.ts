import { z } from "zod"

import { SchemaCodec } from "@wireio/cluster-tool-shared"

/** A named, saved query. */
export const SavedQuerySchema = z.strictObject({
  /** Stable id. */
  id: z.string().min(1),
  /** Unique display name. */
  name: z.string().min(1),
  /** The SQL text. */
  query: z.string().min(1),
  /** ISO-8601 creation time. */
  createdAt: z.iso.datetime(),
  /** ISO-8601 last-update time. */
  updatedAt: z.iso.datetime()
})

/** A saved query. */
export type SavedQuery = z.infer<typeof SavedQuerySchema>

/** Codec for {@link SavedQuerySchema}. */
export const SavedQueryCodec = SchemaCodec.create<SavedQuery>(SavedQuerySchema)

/** The persisted `saved-queries.json` document schema. */
export const SavedQueriesDocumentSchema = z.strictObject({
  /** Every saved query. */
  queries: z.array(SavedQuerySchema)
})

/** The persisted `saved-queries.json` document. */
export type SavedQueriesDocument = z.infer<typeof SavedQueriesDocumentSchema>

/** Codec for {@link SavedQueriesDocumentSchema}. */
export const SavedQueriesDocumentCodec =
  SchemaCodec.create<SavedQueriesDocument>(SavedQueriesDocumentSchema)

/** Document helpers. */
export namespace SavedQueriesDocument {
  /**
   * The empty document.
   *
   * @returns A new document with no queries.
   */
  export function empty(): SavedQueriesDocument {
    return { queries: [] }
  }
}
