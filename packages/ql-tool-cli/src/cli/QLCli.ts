import { identity } from "lodash"
import { match, P } from "ts-pattern"
import type { Argv } from "yargs"

import { ProcessSignalName } from "@wireio/cluster-tool-shared"
import { getLogger, Level, NestedError } from "@wireio/shared"

import type { CliContext } from "./context/index.js"
import { QLExitCode, QLUsageError } from "./exit/index.js"
import { ErrorPrinter } from "./output/index.js"

const log = getLogger(__filename)

/** Global flags of every wql command. */
export interface GlobalOptions {
  /** `--log-level` for diagnostics on stderr (default {@link QLCli.DefaultLogLevel}). */
  logLevel?: Level
}

/** The outcome of {@link QLCli.runInterruptibly}. */
export interface InterruptibleRun<T> {
  /** What the run produced. */
  value: T
  /** Whether SIGINT (Ctrl+C) aborted it. */
  interrupted: boolean
}

/** Parser-level helpers of the wql CLI: the fail handler, handler wrapping, SIGINT. */
export namespace QLCli {
  /** Diagnostic level when `--log-level` is not given (stderr stays quiet on success). */
  export const DefaultLogLevel = Level.error
  /** Hint appended to a usage error. */
  export const UsageHint = "run `wql --help` for usage"
  /** Message of the NestedError that wraps a thrown non-Error value. */
  export const NonErrorThrownMessage = "a non-Error value was thrown"

  /**
   * The yargs `.fail` handler of a run: a parser/validation message (or a
   * {@link QLUsageError}) is printed, the run's exit code becomes
   * {@link QLExitCode.usage}, and the usage error is thrown so yargs stops before
   * any command handler runs ({@link QLCli.completeParse} absorbs it). Any other
   * error is rethrown untouched.
   *
   * @param context - The run context (receives the exit code).
   * @returns The handler.
   */
  export function createFailHandler(context: CliContext): (message: string, error: Error, parser: Argv) => void {
    return (message, error) => {
      if (message == null && !(error instanceof QLUsageError)) throw error
      const usageError = error instanceof QLUsageError ? error : new QLUsageError(message)
      ErrorPrinter.printError(usageError)
      ErrorPrinter.printHint(UsageHint)
      context.exitCode = QLExitCode.usage
      throw usageError
    }
  }

  /**
   * Report an error that ended a run: printed to stderr (message; stack at
   * debug; a usage error adds {@link UsageHint}), and the run's exit code set —
   * {@link QLExitCode.usage} for a {@link QLUsageError}, {@link QLExitCode.failure}
   * for anything else. A thrown non-Error value is wrapped in a NestedError
   * carrying it (a failure, never usage).
   * The ONE error report of the parser, every command handler and the TUI boot.
   *
   * @param context - The run context (receives the exit code).
   * @param error - The caught value.
   * @returns The exit code set.
   */
  export function report(context: CliContext, error: unknown): QLExitCode {
    const failure = match(error)
      .with(P.instanceOf(Error), identity)
      .otherwise(value => new NestedError(NonErrorThrownMessage, { cause: value, context: { value } }))
    const usage = failure instanceof QLUsageError
    ErrorPrinter.printError(failure)
    if (usage) ErrorPrinter.printHint(UsageHint)
    log.debug(`run failed: ${failure.stack}`)
    context.exitCode = usage ? QLExitCode.usage : QLExitCode.failure
    return context.exitCode
  }

  /**
   * Await a parse: a {@link QLUsageError} already printed by the fail handler only
   * keeps {@link QLExitCode.usage}; anything else that escaped is {@link report}ed.
   *
   * @param context - The run context (receives the exit code).
   * @param parse - Runs the parse (sync throws are captured too).
   */
  export async function completeParse(context: CliContext, parse: () => Promise<unknown>): Promise<void> {
    try {
      await parse()
    } catch (error) {
      if (!(error instanceof QLUsageError && context.exitCode === QLExitCode.usage)) report(context, error)
    }
  }

  /**
   * Wrap a command handler: whatever it throws is {@link report}ed.
   *
   * @param context - The run context (receives the exit code).
   * @param run - The handler body.
   * @returns The yargs handler.
   */
  export function handle<A>(context: CliContext, run: (argv: A) => Promise<void>): (argv: A) => Promise<void> {
    return async argv => {
      try {
        await run(argv)
      } catch (error) {
        report(context, error)
      }
    }
  }

  /**
   * Run `run` with an AbortSignal that SIGINT (Ctrl+C) aborts; the listener is
   * removed when the run settles.
   *
   * @param run - Receives the signal.
   * @returns The value and whether SIGINT interrupted it.
   */
  export async function runInterruptibly<T>(run: (signal: AbortSignal) => Promise<T>): Promise<InterruptibleRun<T>> {
    const controller = new AbortController(),
      onInterrupt = () => controller.abort()
    process.once(ProcessSignalName.SIGINT, onInterrupt)
    try {
      const value = await run(controller.signal)
      return { value, interrupted: controller.signal.aborted }
    } finally {
      process.removeListener(ProcessSignalName.SIGINT, onInterrupt)
    }
  }
}
