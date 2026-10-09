import type { z } from "zod"

import type { QueryColumn, QueryRow } from "./QueryResult.js"

/** The part of a result {@link QueryResultShape.refineRowKeys} inspects. */
export interface QueryResultRowsShape {
  /** Result columns — their names are the key set every row must carry. */
  columns: QueryColumn[]
  /** Result rows. */
  rows: QueryRow[]
}

/** Structural checks the per-field schema cannot express. */
export namespace QueryResultShape {
  /**
   * zod refinement: every row's key set equals the column-name set — checked in
   * ONE pass; each mismatching row is reported with its index.
   *
   * @param result - The parsed result (columns + rows).
   * @param context - The zod refinement context issues are added to.
   */
  export function refineRowKeys(
    result: QueryResultRowsShape,
    context: z.RefinementCtx
  ): void {
    const names = new Set(result.columns.map(column => column.name))
    result.rows.forEach((row, index) => {
      const keys = Object.keys(row),
        matches =
          keys.length === names.size && keys.every(key => names.has(key))
      if (!matches) {
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message: `row keys [${keys.join(", ")}] do not match columns [${[...names].join(", ")}]`
        })
      }
    })
  }
}
