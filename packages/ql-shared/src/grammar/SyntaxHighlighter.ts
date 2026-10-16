import { match, P } from "ts-pattern"

import type { Token } from "antlr4ng"

import { WireQueryLexer } from "./generated/WireQueryLexer.js"
import { HighlightTokenKind } from "./HighlightTokenKind.js"
import { WireQueryTokens } from "./WireQueryTokens.js"

/** One classified token (0-based inclusive offsets; 1-based line/column). */
export interface HighlightToken {
  /** Highlight class. */
  kind: HighlightTokenKind
  /** First character offset. */
  start: number
  /** Last character offset (inclusive). */
  stop: number
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
}

/** Lexer-driven token classification (the ONE highlighter of CLI, TUI and GUI). */
export namespace SyntaxHighlighter {
  /**
   * Lex with the generated lexer (never regex) and classify every token; lexer
   * errors (unterminated strings, stray characters) become `error` tokens.
   *
   * @param text - The SQL text.
   * @returns Tokens ordered by `start`.
   */
  export function classify(text: string): HighlightToken[] {
    const { tokens, errors } = WireQueryTokens.lex(text),
      classified = tokens.map(token => ({
        kind: kindOf(token),
        start: token.start,
        stop: token.stop,
        line: token.line,
        column: token.column + 1
      })),
      errorTokens = errors.map(error => ({
        kind: HighlightTokenKind.error,
        start: error.start,
        stop: error.stop,
        line: error.line,
        column: error.column
      }))
    return [...classified, ...errorTokens].sort((left, right) => left.start - right.start)
  }

  /**
   * Highlight class of one token type.
   *
   * @param token - A lexer token.
   * @returns Its class.
   */
  export function kindOf(token: Token): HighlightTokenKind {
    const type = token.type
    return match(type)
      .with(P.when(candidate => WireQueryTokens.Aggregates.has(candidate)), () => HighlightTokenKind.aggregate)
      .with(P.when(candidate => WireQueryTokens.Literals.has(candidate)), () => HighlightTokenKind.literal)
      .with(P.when(candidate => WireQueryTokens.Keywords.has(candidate)), () => HighlightTokenKind.keyword)
      .with(P.when(candidate => WireQueryTokens.Operators.has(candidate)), () => HighlightTokenKind.operator)
      .with(P.when(candidate => WireQueryTokens.Punctuation.has(candidate)), () => HighlightTokenKind.punctuation)
      .with(WireQueryLexer.STRING, () => HighlightTokenKind.string)
      .with(WireQueryLexer.DECIMAL, WireQueryLexer.INTEGER, () => HighlightTokenKind.number)
      .with(WireQueryLexer.QUOTED_IDENTIFIER, () => HighlightTokenKind.quotedIdentifier)
      .with(WireQueryLexer.IDENTIFIER, () => HighlightTokenKind.identifier)
      .otherwise(() => HighlightTokenKind.error)
  }
}
