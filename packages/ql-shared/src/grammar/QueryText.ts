import type { Token } from "antlr4ng"
import { match } from "ts-pattern"

import { WireQueryLexer } from "./generated/WireQueryLexer.js"
import { WireQueryTokens } from "./WireQueryTokens.js"

/** Token-level query text helpers. */
export namespace QueryText {
  /** Identifier quote. */
  export const IdentifierQuote = "\""
  /** String-literal quote. */
  export const StringQuote = "'"

  /**
   * Whether `name` lexes as exactly one plain (unquoted, non-keyword) identifier.
   *
   * @param name - The name.
   * @returns True when it needs no quoting.
   */
  export function isPlainIdentifier(name: string): boolean {
    const { tokens, errors } = WireQueryTokens.lex(name)
    return (
      errors.length === 0 &&
      tokens.length === 1 &&
      tokens[0].type === WireQueryLexer.IDENTIFIER &&
      tokens[0].text === name
    )
  }

  /**
   * Quote an identifier when it is not plain (dots, keywords, other characters).
   *
   * @param name - The name.
   * @returns `name` or `"name"` (embedded quotes doubled).
   */
  export function quoteIdentifier(name: string): string {
    return isPlainIdentifier(name)
      ? name
      : `${IdentifierQuote}${name.replaceAll(IdentifierQuote, IdentifierQuote + IdentifierQuote)}${IdentifierQuote}`
  }

  /**
   * A single-quoted string literal (embedded quotes doubled).
   *
   * @param value - The string.
   * @returns The literal.
   */
  export function quoteString(value: string): string {
    return `${StringQuote}${value.replaceAll(StringQuote, StringQuote + StringQuote)}${StringQuote}`
  }

  /**
   * The name a `"quoted identifier"` denotes (outer quotes removed, doubled quotes undone).
   *
   * @param text - The quoted identifier text.
   * @returns The name.
   */
  export function unquoteIdentifier(text: string): string {
    return unquote(text, IdentifierQuote)
  }

  /**
   * The value a `'string literal'` denotes (outer quotes removed, doubled quotes undone).
   *
   * @param text - The literal text.
   * @returns The value.
   */
  export function unquoteString(text: string): string {
    return unquote(text, StringQuote)
  }

  /**
   * The plain text of a name token: an identifier as written, a quoted
   * identifier or string literal unquoted; absent for no token.
   *
   * @param token - The token (identifier, quoted identifier or string).
   * @returns The name (absent for no token).
   */
  export function nameOf(token: Token): string {
    return match(token?.type)
      .with(WireQueryLexer.QUOTED_IDENTIFIER, () => unquoteIdentifier(token.text))
      .with(WireQueryLexer.STRING, () => unquoteString(token.text))
      .otherwise(() => token?.text)
  }

  /** Strip the outer `quote`s and undo doubled inner ones. */
  function unquote(text: string, quote: string): string {
    return text.slice(quote.length, -quote.length).replaceAll(quote + quote, quote)
  }

  /**
   * `owner.table` with quoting where needed (`"sysio.opreg".operators`).
   *
   * @param owner - The owner account.
   * @param table - The table name.
   * @returns The qualified table reference.
   */
  export function qualifyTable(owner: string, table: string): string {
    return `${quoteIdentifier(owner)}.${quoteIdentifier(table)}`
  }

  /**
   * `SELECT * FROM <qualified>` (describe sends it with request `limit: 0`).
   *
   * @param owner - The owner account.
   * @param table - The table name.
   * @returns The query text.
   */
  export function selectAllQuery(owner: string, table: string): string {
    return `SELECT * FROM ${qualifyTable(owner, table)}`
  }
}
