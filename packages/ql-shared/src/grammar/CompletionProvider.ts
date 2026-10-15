import { match, P } from "ts-pattern"

import type { Token } from "antlr4ng"

import { CatalogSnapshot } from "../catalog/CatalogSnapshot.js"
import { CompletionKind } from "./CompletionKind.js"
import { WireQueryLexer } from "./generated/WireQueryLexer.js"
import { QueryText } from "./QueryText.js"
import { WireQueryTokens } from "./WireQueryTokens.js"

/** One completion candidate. */
export interface CompletionCandidate {
  /** What is offered. */
  kind: CompletionKind
  /** Display label. */
  label: string
  /** Text inserted in place of the typed prefix. */
  insertText: string
  /** Secondary text (ABI type, owner, …). */
  detail: string
}

/** Where the cursor sits, derived from the tokens before it. */
enum CompletionContext {
  owner = "owner",
  ownerList = "ownerList",
  table = "table",
  expression = "expression",
  keyword = "keyword"
}

/** The table a query reads (from `FROM [owner.]table [OWNER …]`). */
interface QueryTableReference {
  owners: string[]
  table: string
}

/** Detail text of keyword / aggregate candidates. */
const KeywordDetail = "keyword"
/** Detail text of aggregate candidates. */
const AggregateDetail = "aggregate"
/** Inserted after an aggregate name. */
const CallOpen = "("
/** Token types naming an owner in an `OWNER a, "b", 'c'` list. */
const OwnerNameTokens: ReadonlySet<number> = new Set([
  WireQueryLexer.IDENTIFIER,
  WireQueryLexer.QUOTED_IDENTIFIER,
  WireQueryLexer.STRING
])

/** Synchronous, context-aware completions from a {@link CatalogSnapshot} (no I/O). */
export namespace CompletionProvider {
  /**
   * Candidates at `offset`: owners/tables after FROM, owners after OWNER, fields
   * (+ aggregates) in expression clauses, keywords otherwise — filtered by the
   * identifier prefix being typed (case-insensitive).
   *
   * @param text - The SQL text.
   * @param offset - Cursor offset (0 … text.length).
   * @param snapshot - Catalog state.
   * @returns Matching candidates.
   */
  export function candidates(
    text: string,
    offset: number,
    snapshot: CatalogSnapshot
  ): CompletionCandidate[] {
    const before = WireQueryTokens.lex(text.slice(0, offset)).tokens,
      last = before.at(-1),
      typing =
        last != null &&
        last.stop === offset - 1 &&
        (last.type === WireQueryLexer.IDENTIFIER || WireQueryTokens.WordTokens.has(last.type)),
      prefix = typing ? last.text.toLowerCase() : "",
      context = before.slice(0, typing ? -1 : before.length),
      reference = tableReference(WireQueryTokens.lex(text).tokens)
    return candidatesFor(contextOf(context), context, reference, snapshot).filter(
      candidate => candidate.label.toLowerCase().startsWith(prefix)
    )
  }

  /** Classify the cursor position from the preceding tokens. */
  function contextOf(tokens: Token[]): CompletionContext {
    const previous = tokens.at(-1)?.type,
      beforePrevious = tokens.at(-2)?.type,
      clause = [...tokens].reverse().find(token => WireQueryTokens.ClauseKeywords.has(token.type))?.type
    return match([previous, beforePrevious, clause])
      .with([WireQueryLexer.FROM, P._, P._], () => CompletionContext.owner)
      .with([WireQueryLexer.DOT, P._, WireQueryLexer.FROM], () => CompletionContext.table)
      .with([P.union(WireQueryLexer.OWNER, WireQueryLexer.COMMA), P._, WireQueryLexer.OWNER], () => CompletionContext.ownerList)
      .with(
        [P._, P._, P.union(WireQueryLexer.SELECT, WireQueryLexer.WHERE, WireQueryLexer.GROUP, WireQueryLexer.HAVING, WireQueryLexer.ORDER)],
        () => CompletionContext.expression
      )
      .otherwise(() => CompletionContext.keyword)
  }

  /** Candidates for a context. */
  function candidatesFor(
    context: CompletionContext,
    tokens: Token[],
    reference: QueryTableReference,
    snapshot: CatalogSnapshot
  ): CompletionCandidate[] {
    return match(context)
      .with(CompletionContext.owner, () => [...ownerCandidates(snapshot, QueryText.quoteIdentifier), ...qualifiedTableCandidates(snapshot)])
      .with(CompletionContext.table, () => tableCandidates(snapshot, ownerBeforeDot(tokens)))
      .with(CompletionContext.ownerList, () => ownerCandidates(snapshot, QueryText.quoteString))
      .with(CompletionContext.expression, () => [
        ...fieldCandidates(snapshot, reference),
        ...aggregateCandidates(),
        ...keywordCandidates()
      ])
      .with(CompletionContext.keyword, () => keywordCandidates())
      .exhaustive()
  }

  /** Owners, inserted through `quote` (identifier after FROM, string after OWNER). */
  function ownerCandidates(
    snapshot: CatalogSnapshot,
    quote: (name: string) => string
  ): CompletionCandidate[] {
    return snapshot.owners.map(owner => ({
      kind: CompletionKind.owner,
      label: owner.account,
      insertText: quote(owner.account),
      detail: `${owner.tables.length} tables`
    }))
  }

  /** `owner.table` pairs for loaded owners. */
  function qualifiedTableCandidates(snapshot: CatalogSnapshot): CompletionCandidate[] {
    return snapshot.owners.flatMap(owner =>
      owner.tables.map(table => ({
        kind: CompletionKind.table,
        label: `${owner.account}.${table.name}`,
        insertText: QueryText.qualifyTable(owner.account, table.name),
        detail: table.rowType
      }))
    )
  }

  /** Tables of one owner. */
  function tableCandidates(snapshot: CatalogSnapshot, owner: string): CompletionCandidate[] {
    return (snapshot.owners.find(candidate => candidate.account === owner)?.tables ?? []).map(table => ({
      kind: CompletionKind.table,
      label: table.name,
      insertText: QueryText.quoteIdentifier(table.name),
      detail: table.rowType
    }))
  }

  /** Fields of the referenced table (first owner that has it). */
  function fieldCandidates(
    snapshot: CatalogSnapshot,
    reference: QueryTableReference
  ): CompletionCandidate[] {
    const table =
      reference == null
        ? null
        : reference.owners
            .map(owner => CatalogSnapshot.lookupTable(snapshot, owner, reference.table))
            .find(candidate => candidate != null)
    return (table?.fields ?? []).map(field => ({
      kind: CompletionKind.field,
      label: field.path,
      insertText: field.path,
      detail: field.logicalType ?? field.abiType
    }))
  }

  /** Aggregate functions. */
  function aggregateCandidates(): CompletionCandidate[] {
    return [...WireQueryTokens.Aggregates].map(type => {
      const name = WireQueryTokens.wordOf(type)
      return { kind: CompletionKind.aggregate, label: name, insertText: `${name}${CallOpen}`, detail: AggregateDetail }
    })
  }

  /** Keywords (and keyword literals). */
  function keywordCandidates(): CompletionCandidate[] {
    const aggregates = new Set(aggregateCandidates().map(candidate => candidate.label))
    return WireQueryTokens.keywordWords()
      .filter(word => !aggregates.has(word))
      .map(word => ({ kind: CompletionKind.keyword, label: word, insertText: word, detail: KeywordDetail }))
  }

  /** Owner name just before a trailing DOT. */
  function ownerBeforeDot(tokens: Token[]): string {
    return QueryText.nameOf(tokens.at(-2))
  }

  /**
   * The `FROM [owner.]table [OWNER a, b]` reference of a token stream, or null
   * without a FROM. The owner list ends at the next clause keyword (WHERE,
   * GROUP, …) — names after it are not owners.
   */
  function tableReference(tokens: Token[]): QueryTableReference {
    const fromIndex = tokens.findIndex(token => token.type === WireQueryLexer.FROM)
    if (fromIndex === -1) return null
    const [first, dot, second] = tokens.slice(fromIndex + 1, fromIndex + 4),
      qualified = dot?.type === WireQueryLexer.DOT && second != null
    if (first == null) return null
    if (qualified) return { owners: [QueryText.nameOf(first)], table: QueryText.nameOf(second) }
    const ownerIndex = tokens.findIndex((token, index) => index > fromIndex + 1 && token.type === WireQueryLexer.OWNER),
      afterOwner = ownerIndex === -1 ? [] : tokens.slice(ownerIndex + 1),
      clauseEnd = afterOwner.findIndex(token => WireQueryTokens.ClauseKeywords.has(token.type)),
      ownerTokens = clauseEnd === -1 ? afterOwner : afterOwner.slice(0, clauseEnd),
      owners = ownerTokens.filter(token => OwnerNameTokens.has(token.type)).map(QueryText.nameOf)
    return { owners, table: QueryText.nameOf(first) }
  }
}
