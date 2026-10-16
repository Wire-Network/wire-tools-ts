import { defaults } from "lodash"
import { match } from "ts-pattern"

import { TerminalNode, type Token } from "antlr4ng"

import { WireQueryLexer } from "./generated/WireQueryLexer.js"
import { KeywordCase } from "./KeywordCase.js"
import { QueryFormatError } from "./QueryFormatError.js"
import { WireQueryTokens } from "./WireQueryTokens.js"

/** Formatter options (all optional). */
export interface QueryFormatOptions {
  /** Keyword casing (default upper). */
  keywordCase?: KeywordCase
  /** Indent (spaces) of a top-level AND/OR continuation line (default 2). */
  indent?: number
}

/** Resolved formatter options. */
export interface QueryFormatConfig extends Required<QueryFormatOptions> {}

/**
 * Defaults for {@link QueryFormatOptions}.
 *
 * @returns The default options.
 */
export function createQueryFormatDefaultOptions(): Partial<QueryFormatOptions> {
  return { keywordCase: KeywordCase.upper, indent: QueryFormatter.DefaultIndent }
}

/** Tokens never preceded by a space. */
const NoSpaceBefore: ReadonlySet<number> = new Set([
  WireQueryLexer.COMMA,
  WireQueryLexer.RPAREN,
  WireQueryLexer.DOT,
  WireQueryLexer.SEMICOLON
])

/** Tokens never followed by a space (signs only occur as unary literal signs). */
const NoSpaceAfter: ReadonlySet<number> = new Set([
  WireQueryLexer.LPAREN,
  WireQueryLexer.DOT,
  WireQueryLexer.PLUS,
  WireQueryLexer.MINUS
])

/** Boolean connectives broken onto their own line at parenthesis depth 0. */
const Connectives: ReadonlySet<number> = new Set([
  WireQueryLexer.AND,
  WireQueryLexer.OR
])

/** Line separator of formatted output. */
const NewLine = "\n"

/** Running state of one formatting pass. */
interface FormatState {
  text: string
  depth: number
  previous: Token
}

/**
 * Client-side SQL beautifier over the PARSE TREE: one clause per line, top-level
 * AND/OR continuation lines, normalized spacing and keyword case. The grammar
 * has no comments and skips whitespace, so formatting is lossless and idempotent.
 */
export namespace QueryFormatter {
  /** Default continuation indent. */
  export const DefaultIndent = 2

  /**
   * Format `text`.
   *
   * @param text - The SQL text.
   * @param options - Keyword case and indent.
   * @returns The formatted text.
   * @throws QueryFormatError (with the parse diagnostics as context) when `text` does not parse.
   */
  export function format(text: string, options: QueryFormatOptions = {}): string {
    const config = defaults({ ...options }, createQueryFormatDefaultOptions()) as QueryFormatConfig,
      parsed = WireQueryTokens.parse(text)
    if (parsed.diagnostics.length > 0) {
      throw new QueryFormatError("cannot format: the query does not parse", {
        context: { diagnostics: parsed.diagnostics }
      })
    }
    const clauseStarts = new Set(
      (parsed.tree.children ?? [])
        .filter((child): child is TerminalNode => child instanceof TerminalNode)
        .map(child => child.symbol)
        .filter(symbol => WireQueryTokens.ClauseKeywords.has(symbol.type))
        .map(symbol => symbol.tokenIndex)
    )
    return parsed.tokens.reduce<FormatState>(
      (state, token) => appendToken(state, token, clauseStarts, config),
      { text: "", depth: 0, previous: null }
    ).text
  }

  /** Append one token with its separator. */
  function appendToken(
    state: FormatState,
    token: Token,
    clauseStarts: ReadonlySet<number>,
    config: QueryFormatConfig
  ): FormatState {
    const separator =
        state.previous == null
          ? ""
          : clauseStarts.has(token.tokenIndex)
            ? NewLine
            : Connectives.has(token.type) && state.depth === 0
              ? `${NewLine}${" ".repeat(config.indent)}`
              : needsSpace(state.previous, token)
                ? " "
                : "",
      depth =
        state.depth +
        (token.type === WireQueryLexer.LPAREN ? 1 : 0) -
        (token.type === WireQueryLexer.RPAREN ? 1 : 0)
    return {
      text: `${state.text}${separator}${tokenText(token, config.keywordCase, clauseStarts)}`,
      depth,
      previous: token
    }
  }

  /** Whether a space separates two adjacent tokens. */
  function needsSpace(previous: Token, token: Token): boolean {
    return !(
      NoSpaceBefore.has(token.type) ||
      NoSpaceAfter.has(previous.type) ||
      (token.type === WireQueryLexer.LPAREN &&
        WireQueryTokens.Aggregates.has(previous.type))
    )
  }

  /**
   * A token's text in the configured keyword case. `OWNER` is a keyword only as
   * the OWNER clause; elsewhere the grammar accepts it as an identifier, whose
   * spelling is never changed.
   */
  function tokenText(token: Token, keywordCase: KeywordCase, clauseStarts: ReadonlySet<number>): string {
    const ownerIdentifier = token.type === WireQueryLexer.OWNER && !clauseStarts.has(token.tokenIndex)
    return WireQueryTokens.WordTokens.has(token.type) && !ownerIdentifier
      ? match(keywordCase)
          .with(KeywordCase.upper, () => token.text.toUpperCase())
          .with(KeywordCase.lower, () => token.text.toLowerCase())
          .with(KeywordCase.preserve, () => token.text)
          .exhaustive()
      : token.text
  }
}
