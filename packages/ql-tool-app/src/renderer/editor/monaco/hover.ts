import type * as Monaco from "monaco-editor"

import type { CatalogField, CatalogSnapshot } from "@wireio/ql-shared"

import { DisplayText } from "../../common/index.js"

import type { SnapshotSource } from "./completion.js"

/** Hover with field types (ABI type + logical type) from the catalog snapshot. */
export namespace Hover {
  /**
   * Fields named `word` (or ending in `.word`) across the snapshot.
   *
   * @param snapshot - Catalog snapshot.
   * @param word - The hovered identifier.
   * @returns `owner.table.path` + field pairs.
   */
  export function fieldsNamed(snapshot: CatalogSnapshot, word: string): Array<[string, CatalogField]> {
    return snapshot.owners.flatMap(owner =>
      owner.tables.flatMap(table =>
        table.fields
          .filter(field => field.path === word || field.path.endsWith(`.${word}`))
          .map(field => [`${owner.account}.${table.name}.${field.path}`, field] as [string, CatalogField])
      )
    )
  }

  /**
   * The hover provider.
   *
   * @param snapshot - Latest catalog snapshot.
   * @returns The provider.
   */
  export function createProvider(snapshot: SnapshotSource): Monaco.languages.HoverProvider {
    return {
      provideHover: (model, position) => {
        const word = model.getWordAtPosition(position),
          current = snapshot()
        if (word == null || current == null) return null
        const fields = fieldsNamed(current, word.word)
        if (fields.length === 0) return null
        return {
          contents: fields.map(([name, field]) => ({
            value: `\`${name}\` — ${field.role} · ${DisplayText.fieldType(field)}`
          }))
        }
      }
    }
  }
}
