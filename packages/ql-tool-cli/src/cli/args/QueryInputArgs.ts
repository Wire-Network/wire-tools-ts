import Fs from "node:fs"
import { text as readStreamText } from "node:stream/consumers"

import { match, P } from "ts-pattern"
import type { Argv } from "yargs"

import { QLUsageError } from "../exit/index.js"

/** Parsed query-source flags (undefined = not given). */
export interface QueryInputOptions {
  /** Positional SQL text; `-` reads stdin. */
  query?: string
  /** `--query-file`: read the SQL from a file. */
  queryFile?: string
}

/** Where stdin comes from (injected for tests). */
export interface QueryTextSource {
  /** The stdin stream. */
  stdin: NodeJS.ReadableStream
  /** Whether stdin is an interactive terminal (then it is never read implicitly). */
  stdinIsTTY: boolean
}

/**
 * Register the query-source flags (the positional `[query]` is declared by the
 * command string).
 *
 * @param builder - The yargs builder.
 * @returns The builder.
 */
export function applyQueryInputArgs<T>(builder: Argv<T>) {
  return builder
    .positional("query", {
      type: "string",
      describe: `SQL text; ${QueryInputArgs.StdinMarker} reads stdin`
    })
    .option("query-file", { alias: "F", type: "string", describe: "read the SQL from a file" })
}

/** Query-source resolution. */
export namespace QueryInputArgs {
  /** Positional value meaning "read stdin". */
  export const StdinMarker = "-"
  /** The refusal of an empty (or whitespace-only) query — the CLI's usage error and the TUI's warning. */
  export const EmptyQueryText = "the query is empty"

  /**
   * The query text from EXACTLY one source: the positional, `--query-file`, or stdin
   * (`-`, or piped stdin when neither other source is given).
   *
   * @param options - The parsed flags.
   * @param source - stdin and whether it is a terminal.
   * @returns The SQL text (trimmed).
   * @throws QLUsageError for zero or several sources, or an empty query.
   */
  export async function readQueryText(options: QueryInputOptions, source: QueryTextSource): Promise<string> {
    const { query, queryFile } = options,
      fromStdin = query === StdinMarker || (query == null && queryFile == null && !source.stdinIsTTY),
      sources = [query != null && query !== StdinMarker, queryFile != null, fromStdin].filter(Boolean).length
    if (sources === 0) {
      throw new QLUsageError("no query: pass it as an argument, with --query-file <file>, or on stdin")
    }
    if (sources > 1) {
      throw new QLUsageError("give the query once: as an argument, with --query-file, or on stdin — not several")
    }
    const text = await match({ fromStdin, queryFile })
      .with({ fromStdin: true }, () => readStreamText(source.stdin))
      .with({ queryFile: P.nonNullable }, ({ queryFile: file }) => readFile(file))
      .otherwise(() => query)
    if (text.trim().length === 0) throw new QLUsageError(EmptyQueryText)
    return text.trim()
  }

  /** Read a query file; a missing file is a usage problem. */
  function readFile(queryFile: string): string {
    if (!Fs.existsSync(queryFile)) {
      throw new QLUsageError(`query file not found: ${queryFile}`, { context: { queryFile } })
    }
    return Fs.readFileSync(queryFile, "utf8")
  }
}
