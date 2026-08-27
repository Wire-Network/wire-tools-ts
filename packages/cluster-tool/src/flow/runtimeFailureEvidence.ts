/**
 * Return whether a log line reports a terminal Solana program-execution
 * failure. Solana surfaces the same error in compact enum form and as a
 * human-readable RPC message.
 *
 * @param line - Runtime log line to inspect.
 * @return Whether the line contains a terminal Solana program failure.
 */
export function isSolanaProgramRuntimeFailure(line: string): boolean {
  return /SBF program panicked|Program(?:FailedToComplete|\s+failed\s+to\s+complete)/i.test(
    line
  )
}
