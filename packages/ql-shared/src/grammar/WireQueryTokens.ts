import {
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  Token,
  type ATNSimulator,
  type RecognitionException,
  type Recognizer
} from "antlr4ng"

import { WireQueryLexer } from "./generated/WireQueryLexer.js"
import { WireQueryParser, type QueryContext } from "./generated/WireQueryParser.js"
import type { QueryDiagnostic } from "./QueryDiagnostics.js"

/** A lexer recognition error with its source span (0-based offsets, inclusive stop). */
export interface LexerErrorSpan {
  /** First offending character offset. */
  start: number
  /** Last offending character offset (inclusive). */
  stop: number
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  /** The recognizer's message. */
  message: string
}

/** The token stream of a text plus its lexer errors. */
export interface LexedQuery {
  /** Every default-channel token, EOF excluded. */
  tokens: Token[]
  /** Lexer errors (unrecognized characters, unterminated strings…). */
  errors: LexerErrorSpan[]
}

/** A parse of a text: tree, tokens and every grammar-level diagnostic. */
export interface ParsedQuery {
  /** The `query` parse tree (best effort when diagnostics are present). */
  tree: QueryContext
  /** Every default-channel token, EOF excluded. */
  tokens: Token[]
  /** Lexer + parser diagnostics, in report order. */
  diagnostics: QueryDiagnostic[]
}

/** Collects lexer errors with their character span. */
class LexerErrorCollector extends BaseErrorListener {
  readonly errors: LexerErrorSpan[] = []

  override syntaxError<S extends Token, T extends ATNSimulator>(
    recognizer: Recognizer<T>,
    _offendingSymbol: S | null,
    line: number,
    column: number,
    message: string,
    _error: RecognitionException | null
  ): void {
    const lexer = recognizer as unknown as WireQueryLexer,
      start = lexer.tokenStartCharIndex,
      stop = Math.max(start, lexer.inputStream.index - 1)
    this.errors.push({ start, stop, line, column: column + 1, message })
  }
}

/** Collects parser errors as diagnostics. */
class ParserErrorCollector extends BaseErrorListener {
  readonly diagnostics: QueryDiagnostic[] = []

  override syntaxError<S extends Token, T extends ATNSimulator>(
    _recognizer: Recognizer<T>,
    offendingSymbol: S | null,
    line: number,
    column: number,
    message: string,
    _error: RecognitionException | null
  ): void {
    const length =
      offendingSymbol == null
        ? 1
        : Math.max(1, offendingSymbol.stop - offendingSymbol.start + 1)
    this.diagnostics.push({ message, line, column: column + 1, length })
  }
}

/** Token classification + lexing/parsing over the generated WireQuery grammar (never regex). */
export namespace WireQueryTokens {
  /** Clause-starting keywords (formatter line breaks, completion context). */
  export const ClauseKeywords: ReadonlySet<number> = new Set([
    WireQueryLexer.SELECT,
    WireQueryLexer.FROM,
    WireQueryLexer.OWNER,
    WireQueryLexer.WHERE,
    WireQueryLexer.GROUP,
    WireQueryLexer.HAVING,
    WireQueryLexer.ORDER,
    WireQueryLexer.LIMIT
  ])
  /** Every keyword token (clauses, modifiers and boolean operators). */
  export const Keywords: ReadonlySet<number> = new Set([
    ...ClauseKeywords,
    WireQueryLexer.BY,
    WireQueryLexer.AS,
    WireQueryLexer.ASC,
    WireQueryLexer.DESC,
    WireQueryLexer.NOT,
    WireQueryLexer.AND,
    WireQueryLexer.OR,
    WireQueryLexer.IS
  ])
  /** Aggregate function tokens. */
  export const Aggregates: ReadonlySet<number> = new Set([
    WireQueryLexer.COUNT_AGGREGATE,
    WireQueryLexer.SUM_AGGREGATE,
    WireQueryLexer.AVG_AGGREGATE,
    WireQueryLexer.MIN_AGGREGATE,
    WireQueryLexer.MAX_AGGREGATE
  ])
  /** Keyword literals. */
  export const Literals: ReadonlySet<number> = new Set([
    WireQueryLexer.NULL_LITERAL,
    WireQueryLexer.TRUE_LITERAL,
    WireQueryLexer.FALSE_LITERAL
  ])
  /** Comparison / sign / star operators. */
  export const Operators: ReadonlySet<number> = new Set([
    WireQueryLexer.EQ,
    WireQueryLexer.NE,
    WireQueryLexer.LE,
    WireQueryLexer.LT,
    WireQueryLexer.GE,
    WireQueryLexer.GT,
    WireQueryLexer.PLUS,
    WireQueryLexer.MINUS,
    WireQueryLexer.STAR
  ])
  /** Punctuation tokens. */
  export const Punctuation: ReadonlySet<number> = new Set([
    WireQueryLexer.LPAREN,
    WireQueryLexer.RPAREN,
    WireQueryLexer.DOT,
    WireQueryLexer.COMMA,
    WireQueryLexer.SEMICOLON
  ])
  /** Tokens whose text is a word with keyword meaning (keyword case applies). */
  export const WordTokens: ReadonlySet<number> = new Set([
    ...Keywords,
    ...Aggregates,
    ...Literals
  ])
  /** Quote wrapping a literal name in the grammar's `literalNames`. */
  const LiteralNameQuote = "'"

  /**
   * The word of a keyword-like token type, from the lexer's literal names
   * (`'SELECT'` → `SELECT`) — the ONE literal-name unquoting.
   *
   * @param type - A token type with a literal name.
   * @returns The word.
   */
  export function wordOf(type: number): string {
    return WireQueryLexer.literalNames[type].replaceAll(LiteralNameQuote, "")
  }

  /**
   * Every keyword word of the grammar, upper case (derived from the lexer's literal names).
   *
   * @returns Keyword words, e.g. `SELECT`, `COUNT`, `NULL`.
   */
  export function keywordWords(): string[] {
    return [...WordTokens].map(wordOf)
  }

  /** A generated lexer over `text` reporting to `collector` only. */
  function createLexer(text: string, collector: LexerErrorCollector): WireQueryLexer {
    const lexer = new WireQueryLexer(CharStream.fromString(text))
    lexer.removeErrorListeners()
    lexer.addErrorListener(collector)
    return lexer
  }

  /**
   * Lex `text` with the generated lexer.
   *
   * @param text - The SQL text.
   * @returns Tokens (EOF excluded) and lexer errors.
   */
  export function lex(text: string): LexedQuery {
    const collector = new LexerErrorCollector(),
      lexer = createLexer(text, collector),
      tokens = lexer
      .getAllTokens()
      .filter(token => token.channel === Token.DEFAULT_CHANNEL)
    return { tokens, errors: collector.errors }
  }

  /**
   * Lex + parse `text` with the generated parser, collecting every diagnostic.
   *
   * @param text - The SQL text.
   * @returns The parse.
   */
  export function parse(text: string): ParsedQuery {
    const lexerErrors = new LexerErrorCollector(),
      parserErrors = new ParserErrorCollector(),
      stream = new CommonTokenStream(createLexer(text, lexerErrors)),
      parser = new WireQueryParser(stream)
    parser.removeErrorListeners()
    parser.addErrorListener(parserErrors)
    const tree = parser.query(),
      tokens = stream
        .getTokens()
        .filter(
          token =>
            token.type !== Token.EOF && token.channel === Token.DEFAULT_CHANNEL
        ),
      lexerDiagnostics: QueryDiagnostic[] = lexerErrors.errors.map(error => ({
        message: error.message,
        line: error.line,
        column: error.column,
        length: error.stop - error.start + 1
      }))
    return {
      tree,
      tokens,
      diagnostics: [...lexerDiagnostics, ...parserErrors.diagnostics]
    }
  }
}
