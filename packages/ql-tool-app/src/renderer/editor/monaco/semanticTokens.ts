import type * as Monaco from "monaco-editor"

import { HighlightTokenKind, SyntaxHighlighter, type HighlightToken } from "@wireio/ql-shared"

/** Monaco semantic tokens from the ONE lexer-driven highlighter (`SyntaxHighlighter.classify`). */
export namespace SemanticTokens {
  /** Token types in legend order (the encoded type index is the position here). */
  export const TokenTypes: readonly HighlightTokenKind[] = Object.values(HighlightTokenKind)
  /** Entries per token in Monaco's encoded array. */
  export const EncodedWidth = 5

  /**
   * The provider legend.
   *
   * @returns The legend.
   */
  export function legend(): Monaco.languages.SemanticTokensLegend {
    return { tokenTypes: [...TokenTypes], tokenModifiers: [] }
  }

  /**
   * Encode classified tokens as Monaco's relative `[deltaLine, deltaStart, length, type, modifiers]` array
   * (multi-line tokens are clipped to their first line).
   *
   * @param text - The model text.
   * @param tokens - Classified tokens (ordered by start).
   * @returns The encoded data.
   */
  export function encode(text: string, tokens: HighlightToken[]): Uint32Array {
    const data: number[] = []
    let previousLine = 0,
      previousColumn = 0
    tokens.forEach(token => {
      const line = token.line - 1,
        column = token.column - 1,
        newline = text.indexOf("\n", token.start),
        end = newline >= 0 && newline <= token.stop ? newline : token.stop + 1,
        length = Math.max(1, end - token.start),
        deltaLine = line - previousLine,
        deltaStart = deltaLine === 0 ? column - previousColumn : column
      data.push(deltaLine, deltaStart, length, TokenTypes.indexOf(token.kind), 0)
      previousLine = line
      previousColumn = column
    })
    return Uint32Array.from(data)
  }

  /**
   * Tokens on the lines of `range` (1-based, inclusive).
   *
   * @param tokens - Classified tokens.
   * @param range - The requested range.
   * @returns The tokens starting inside it.
   */
  export function withinLines(tokens: HighlightToken[], range: Monaco.IRange): HighlightToken[] {
    return tokens.filter(token => token.line >= range.startLineNumber && token.line <= range.endLineNumber)
  }

  /**
   * The range semantic tokens provider. Monaco's standalone `semanticTokens`
   * feature (viewport tokens) is what the editor API bundle ships, so tokens are
   * provided per visible range; positions stay relative to the document start.
   *
   * @returns The provider.
   */
  export function createProvider(): Monaco.languages.DocumentRangeSemanticTokensProvider {
    return {
      getLegend: legend,
      provideDocumentRangeSemanticTokens: (model, range) => {
        const text = model.getValue()
        return { data: encode(text, withinLines(SyntaxHighlighter.classify(text), range)) }
      }
    }
  }
}
