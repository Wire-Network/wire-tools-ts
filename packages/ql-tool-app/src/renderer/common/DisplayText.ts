import type { CatalogField, QueryFailure } from "@wireio/ql-shared"

/** The renderer's shared one-line texts (the same fact reads the same in every panel). */
export namespace DisplayText {
  /** Separator between the parts of a field's type. */
  export const TypeSeparator = " · "

  /**
   * A catalog field's type: its ABI type, plus the logical type once a describe filled it.
   *
   * @param field - The catalog field.
   * @returns `uint64` or `uint64 · integer`.
   */
  export function fieldType(field: CatalogField): string {
    return field.logicalType == null ? field.abiType : `${field.abiType}${TypeSeparator}${field.logicalType}`
  }

  /**
   * A failure as one line: the engine error kind (or the failure class) and the message.
   *
   * @param failure - The failure.
   * @returns `QUERY_SYNTAX: …` / `transport: query host exited`.
   */
  export function failureLine(failure: QueryFailure): string {
    return `${failure.data?.kind ?? failure.kind}: ${failure.message}`
  }
}
