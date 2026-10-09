import type * as Monaco from "monaco-editor"

import { QueryDiagnostics, type QueryDiagnostic, type QueryFailure } from "@wireio/ql-shared"

/** Editor markers: grammar diagnostics (debounced while typing) and engine failures. */
export namespace Diagnostics {
  /** Marker owner of grammar diagnostics. */
  export const GrammarOwner = "wirequery-grammar"
  /** Marker owner of engine failures. */
  export const EngineOwner = "wirequery-engine"
  /** Typing debounce (ms). */
  export const DebounceMs = 250

  /**
   * One marker of a 1-based diagnostic.
   *
   * @param monaco - The Monaco API.
   * @param diagnostic - The diagnostic.
   * @returns The marker.
   */
  export function toMarker(monaco: typeof Monaco, diagnostic: QueryDiagnostic): Monaco.editor.IMarkerData {
    return {
      severity: monaco.MarkerSeverity.Error,
      message: diagnostic.message,
      startLineNumber: diagnostic.line,
      startColumn: diagnostic.column,
      endLineNumber: diagnostic.line,
      endColumn: diagnostic.column + diagnostic.length
    }
  }

  /**
   * Replace the grammar markers of a model.
   *
   * @param monaco - The Monaco API.
   * @param model - The model.
   */
  export function applyGrammarMarkers(monaco: typeof Monaco, model: Monaco.editor.ITextModel): void {
    monaco.editor.setModelMarkers(
      model,
      GrammarOwner,
      QueryDiagnostics.check(model.getValue()).map(diagnostic => toMarker(monaco, diagnostic))
    )
  }

  /**
   * Show (or clear, with null) the engine failure of the last run.
   *
   * @param monaco - The Monaco API.
   * @param model - The model.
   * @param failure - The engine failure (null clears).
   * @param query - The SQL that was sent.
   */
  export function applyEngineFailure(
    monaco: typeof Monaco,
    model: Monaco.editor.ITextModel,
    failure: QueryFailure,
    query: string
  ): void {
    monaco.editor.setModelMarkers(
      model,
      EngineOwner,
      failure?.data?.line == null ? [] : [toMarker(monaco, QueryDiagnostics.fromEngineError(failure, query))]
    )
  }
}
