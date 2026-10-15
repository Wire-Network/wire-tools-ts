import type * as Monaco from "monaco-editor"
import { match } from "ts-pattern"

import { CompletionKind, CompletionProvider, type CatalogSnapshot, type CompletionCandidate } from "@wireio/ql-shared"

/** Supplies the latest catalog snapshot (null before any load). */
export type SnapshotSource = () => CatalogSnapshot

/** Monaco completion from `CompletionProvider.candidates` + the current snapshot. */
export namespace Completion {
  /** Characters that open the suggest widget. */
  export const TriggerCharacters = [".", " ", "\""]

  /**
   * Monaco item kind of a candidate kind.
   *
   * @param monaco - The Monaco API.
   * @param kind - Candidate kind.
   * @returns The item kind.
   */
  export function itemKindOf(monaco: typeof Monaco, kind: CompletionKind): Monaco.languages.CompletionItemKind {
    return match(kind)
      .with(CompletionKind.keyword, () => monaco.languages.CompletionItemKind.Keyword)
      .with(CompletionKind.aggregate, () => monaco.languages.CompletionItemKind.Function)
      .with(CompletionKind.owner, () => monaco.languages.CompletionItemKind.Module)
      .with(CompletionKind.table, () => monaco.languages.CompletionItemKind.Struct)
      .with(CompletionKind.field, () => monaco.languages.CompletionItemKind.Field)
      .exhaustive()
  }

  /**
   * Map candidates to Monaco items replacing the word under the cursor.
   *
   * @param monaco - The Monaco API.
   * @param candidates - Candidates.
   * @param range - The range the inserted text replaces.
   * @returns The items.
   */
  export function toItems(
    monaco: typeof Monaco,
    candidates: CompletionCandidate[],
    range: Monaco.IRange
  ): Monaco.languages.CompletionItem[] {
    return candidates.map(candidate => ({
      label: candidate.label,
      kind: itemKindOf(monaco, candidate.kind),
      insertText: candidate.insertText,
      detail: candidate.detail,
      range
    }))
  }

  /**
   * The completion provider.
   *
   * @param monaco - The Monaco API.
   * @param snapshot - Latest catalog snapshot.
   * @returns The provider.
   */
  export function createProvider(
    monaco: typeof Monaco,
    snapshot: SnapshotSource
  ): Monaco.languages.CompletionItemProvider {
    return {
      triggerCharacters: TriggerCharacters,
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position),
          range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          current = snapshot()
        if (current == null) return { suggestions: [] }
        const candidates = CompletionProvider.candidates(model.getValue(), model.getOffsetAt(position), current)
        return { suggestions: toItems(monaco, candidates, range) }
      }
    }
  }
}
