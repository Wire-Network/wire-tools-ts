import {
  QueryDiagnostics,
  QueryFailureKind,
  type QueryFailure
} from "@wireio/ql-shared"

import { getStderrLogger } from "../../logger.js"

const stderr = getStderrLogger()

/** Caret marking the failing token. */
const Caret = "^"
/** SQL line separator. */
const LinePattern = /\r?\n/

/** User-facing error output (stderr, unformatted). */
export namespace ErrorPrinter {
  /** Prefix of every error line. */
  export const ErrorPrefix = "error:"
  /** Hint printed for a server-retryable failure. */
  export const RetryHint = "hint: the server marked this failure retryable — rerun the query"

  /**
   * The lines describing a failed execution: kind + message, then — for a
   * positional engine error — the offending SQL line with a caret under the
   * reported column, then the retry hint when the server marked it retryable.
   *
   * @param failure - The execution failure.
   * @param query - The SQL text that was sent.
   * @returns The lines.
   */
  export function failureLines(failure: QueryFailure, query: string): string[] {
    const label = failure.kind === QueryFailureKind.engine ? failure.data.kind : failure.kind,
      positional = failure.kind === QueryFailureKind.engine && failure.data.line != null
    return [
      `${ErrorPrefix} ${label}: ${failure.message}`,
      ...(positional ? caretLines(failure, query) : []),
      ...(failure.data?.retryable ? [RetryHint] : [])
    ]
  }

  /**
   * Print a failed execution to stderr.
   *
   * @param failure - The execution failure.
   * @param query - The SQL text that was sent.
   */
  export function printFailure(failure: QueryFailure, query: string): void {
    failureLines(failure, query).forEach(line => stderr.error(line))
  }

  /**
   * Print an operational or usage error to stderr.
   *
   * @param error - The error.
   */
  export function printError(error: Error): void {
    stderr.error(`${ErrorPrefix} ${error.message}`)
  }

  /**
   * Print a hint line to stderr.
   *
   * @param hint - The hint text.
   */
  export function printHint(hint: string): void {
    stderr.warn(hint)
  }

  /** The offending SQL line and a caret line under the reported column. */
  function caretLines(failure: QueryFailure, query: string): string[] {
    const diagnostic = QueryDiagnostics.fromEngineError(failure, query),
      sqlLine = query.split(LinePattern)[diagnostic.line - 1] ?? ""
    return [`  ${sqlLine}`, `  ${" ".repeat(Math.max(0, diagnostic.column - 1))}${Caret.repeat(diagnostic.length)}`]
  }
}
