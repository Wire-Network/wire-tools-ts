import type { QueryFailure } from "../client/QueryFailure.js"
import { WireQueryTokens } from "./WireQueryTokens.js"

/** 1-based diagnostic, same convention as engine `error.data`. */
export interface QueryDiagnostic {
  /** What is wrong. */
  message: string
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  /** Characters to underline (≥ 1). */
  length: number
}

/** Grammar-level diagnostics (lexer + parser) and engine-error mapping. */
export namespace QueryDiagnostics {
  /** Line/column used when an engine failure carries no position. */
  export const DefaultPosition = 1

  /**
   * Lexer+parser errors only (grammar level). Semantic rejections (missing
   * OWNER, unknown field) are NOT reported — only the engine knows those.
   *
   * @param text - The SQL text.
   * @returns Diagnostics in report order (empty when the text parses).
   */
  export function check(text: string): QueryDiagnostic[] {
    return WireQueryTokens.parse(text).diagnostics
  }

  /**
   * Map an engine failure onto the text: its 1-based position (or 1:1), its
   * message, and the length of the token starting there (else 1).
   *
   * @param failure - The execution failure.
   * @param text - The SQL text that was sent.
   * @returns The diagnostic.
   */
  export function fromEngineError(failure: QueryFailure, text: string): QueryDiagnostic {
    const line = failure.data?.line ?? DefaultPosition,
      column = failure.data?.column ?? DefaultPosition,
      token = WireQueryTokens.lex(text).tokens.find(
        candidate => candidate.line === line && candidate.column + 1 === column
      )
    return {
      message: failure.message,
      line,
      column,
      length: token == null ? 1 : token.stop - token.start + 1
    }
  }
}
