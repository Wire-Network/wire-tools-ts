import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { asOption } from "@3fv/prelude-ts"
import { isPlainObject, negate } from "lodash"
import { isMatching, match, P } from "ts-pattern"

import { getLogger, getValue } from "@wireio/shared"

import { StepExtraRecorder } from "../../../report/tools/StepExtraRecorder.js"
import { retry } from "../../../utils/asyncUtils.js"
import { isNotEmpty } from "../../../utils/predicateUtils.js"
import { maskSecretArgs } from "../../../utils/secretUtils.js"

const log = getLogger("ClioRunner")
const execFileAsync = promisify(execFile)

/**
 * Caller config for the clio transport. `nodeopUrl` / `kiodUrl` (renamed from
 * the old `url` / `walletUrl`) match `WireClient`. `kiodUrl` is `null` when kiod
 * is addressed via its default unix socket.
 */
export interface ClioRunnerConfig {
  readonly clusterPath: string
  readonly binary: string
  readonly nodeopUrl: string
  readonly kiodUrl: string | null
}

/** Options for {@link ClioRunner.run}. */
export interface ClioRunOptions<UseJson extends boolean = false> {
  json?: UseJson
}

/** JSON-mode run options, with an optional row constructor. */
export interface ClioRunOptionsJson<
  T extends object
> extends ClioRunOptions<true> {
  ctor?: new (data: any) => T
}

/**
 * The duck-typed shape of a failed clio invocation: node's `execFile` rejection
 * carries `message` plus the child's captured streams. Read structurally (NOT
 * `instanceof Error`) — jest gives each module registry its own `Error` global,
 * so a cross-realm `instanceof` is false. Every member stays optional and every
 * read stays guarded: an arbitrary thrown value may carry none of them.
 */
export interface ClioError {
  message?: string
  stdout?: string
  stderr?: string
  /** Set by `execFile` when it killed the child (its timeout). */
  killed?: boolean
  /** The signal that ended the child, when one did. */
  signal?: string
}

/**
 * Fold a failed clio child's captured streams into `err.message` so
 * negative-path assertions can see the chain reason. Duck-typed (NOT
 * `instanceof Error`) — jest gives each module registry its own `Error` global,
 * so cross-realm `instanceof` is false and the enrichment would silently skip.
 *
 * @param error - The error thrown by the exec call.
 * @param stdout - The child's captured stdout ("" when none).
 * @param stderr - The child's captured stderr ("" when none).
 * @returns The same error, its `message` enriched with both streams.
 */
export function enrichClioError(
  error: unknown,
  stdout: string,
  stderr: string
): unknown {
  const candidate = error as ClioError
  if (
    candidate != null &&
    typeof candidate === "object" &&
    typeof candidate.message === "string"
  ) {
    candidate.message = [candidate.message, stdout, stderr]
      .filter(isNotEmpty)
      .join("\n")
  }
  return error
}

/** Parse clio `-j` stdout, or return it trimmed when it is not JSON. */
function parseJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return stdout.trim()
  }
}

/**
 * Private `execFile` transport for the `clio` CLI — the only surface other
 * `clients/wire` files use to shell out to clio. Folds chain-side rejection
 * detail into thrown errors via {@link enrichClioError}.
 */
export class ClioRunner {
  constructor(readonly config: ClioRunnerConfig) {}

  /** Run a clio command, returning parsed JSON. */
  run<T extends object>(
    args: string[],
    options: ClioRunOptionsJson<T>
  ): Promise<T>
  /** Run a clio command, returning raw stdout. */
  run(args: string[], options?: ClioRunOptions): Promise<string>
  async run(
    args: string[],
    options: ClioRunOptions | ClioRunOptionsJson<any> = { json: false }
  ): Promise<any> {
    const fullArgs = [
      "-u",
      this.config.nodeopUrl,
      ...(this.config.kiodUrl ? ["--wallet-url", this.config.kiodUrl] : []),
      ...args
    ]
    log.debug("clio %s", fullArgs.join(" "))
    // Retries only a failed connection (`TransportFailurePattern`): nothing reached the
    // node, so even a push may re-run. Any other error is the result; a push not proven
    // unapplied (`isProvenUnapplied`) must never re-run, as clio re-signs it into a new
    // transaction. Every logical clio invocation — command line, outcome, duration — is
    // recorded into the running step's `Report.StepResult.extra`.
    const startedAtMs = Date.now(),
      // MASKED, not raw: this array is serialized verbatim into the Report, and
      // `wallet import --private-key …` / `wallet unlock --password …` carry the
      // secret in argv. The executable and every other argument survive intact.
      command = maskSecretArgs([this.config.binary, ...fullArgs])
    try {
      const result = await retry(() => this.runOnce(fullArgs, options), {
        maxAttempts: ClioRunner.TransportRetryAttempts,
        delayMs: ClioRunner.TransportRetryDelayMs,
        label: `clio ${args[0] ?? ""} transport`,
        checkResult: negate(ClioRunner.isTransportFailure)
      })
      StepExtraRecorder.record({
        client: "clio",
        kind: "cli",
        command,
        ok: true,
        durationMs: Date.now() - startedAtMs,
        result: ClioRunner.summarizeResult(result)
      })
      return result
    } catch (error) {
      StepExtraRecorder.record({
        client: "clio",
        kind: "cli",
        command,
        ok: false,
        durationMs: Date.now() - startedAtMs,
        error: ClioRunner.truncateForRecord(
          error instanceof Error ? error.message : String(error)
        )
      })
      throw error
    }
  }

  /** One clio subprocess execution (the retry loop above owns transport failures). */
  private async runOnce(
    fullArgs: string[],
    options: ClioRunOptions | ClioRunOptionsJson<any>
  ): Promise<any> {
    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.binary,
        fullArgs,
        {
          maxBuffer: ClioRunner.MaxBuffer,
          timeout: ClioRunner.CommandTimeoutMs
        }
      )
      asOption(stderr)
        .filter(isNotEmpty)
        .match({
          Some: text => log.warn("clio stderr: %s", text),
          None: () => null
        })
      if (options.json) {
        const result = parseJsonOutput(stdout)
        // `clio push transaction` prints a failed trace and still exits 0; fail it as
        // `push action` does, so the catch below reports it like any failed command.
        if (ClioRunner.isFailedTransactionTrace(result))
          throw Object.assign(
            new Error(ClioRunner.FailedTransactionTraceMessage),
            {
              stdout,
              stderr
            }
          )
        return result
      }
      return stdout.trim()
    } catch (error) {
      const stderr = error?.stderr?.toString() ?? "",
        stdout = error?.stdout?.toString() ?? ""
      asOption(stdout)
        .filter(isNotEmpty)
        .match({
          Some: out => log.error("clio stdout: %s", out),
          None: () => null
        })
      log.error(`clio failed: ${stderr}`, error)
      throw enrichClioError(error, stdout, stderr)
    }
  }
}

export namespace ClioRunner {
  /** Maximum stdout buffer for a clio subprocess (bytes). */
  export const MaxBuffer = 10 * 1_024 * 1_024
  /** Timeout for a single clio command (ms). */
  export const CommandTimeoutMs = 30_000
  /** Attempts for CONNECTION-level failures (the node keeps serving; churn transient). */
  export const TransportRetryAttempts = 4
  /** Delay between transport retries (ms). */
  export const TransportRetryDelayMs = 1_500

  /**
   * clio's failed-connection signatures: its `connection_exception`, which its libcurl
   * transport raises only for `CURLE_COULDNT_CONNECT` / `CURLE_URL_MALFORMAT`, so nothing
   * reached the node.
   */
  export const TransportFailurePattern =
    /Failed http request to nodeop|Connection refused|couldn't connect to server/i

  /** The chain error code clio prints for a failed command (`Error 3050003: …`). */
  export const ChainErrorCodePattern = /Error (3\d{6}):/

  /** Lower bound of the chain exception family accepted as rejection evidence. */
  const ChainErrorCodeMinimum = 3_000_000
  /** Upper bound of the chain exception family accepted as rejection evidence. */
  const ChainErrorCodeMaximum = 3_999_999
  /** clio's text-mode prefix, used to apply the same HTTP exclusion to JSON codes. */
  const ChainErrorCodePrefix = "Error "
  /** JSON-looking stdout must never be scanned as text-mode rejection evidence. */
  const JsonResponsePrefixPattern = /^\s*[[{]/

  /**
   * clio's `http_exception` family (`Error 3200000`–`3200006`): an HTTP failure after the
   * connection opened, such as a reply that never arrived, so the request may have reached
   * the node.
   */
  export const HttpExceptionPattern = /Error 3200\d{3}\b/

  /** `tx_duplicate`: the node already has the transaction. */
  export const DuplicateTransactionCode = 3040008

  /** The message of the error {@link ClioRunner.run} throws for a failed trace clio printed with exit 0. */
  export const FailedTransactionTraceMessage =
    "clio printed a failed transaction trace"

  /**
   * True when `result` is a transaction trace the chain failed: its `processed.except` is
   * an object. `clio push action` exits non-zero on one; `clio push transaction` prints it
   * and exits 0, so the runner fails that command itself.
   *
   * @param result - A clio `-j` result, parsed or raw.
   * @returns True for a failed transaction trace.
   */
  export function isFailedTransactionTrace(result: unknown): boolean {
    return isMatching({ processed: { except: P.when(isPlainObject) } }, result)
  }

  /** True when `error` is a failed clio connection (safe to re-run). */
  export function isTransportFailure(error: unknown): boolean {
    const candidate = error as ClioError
    return (
      candidate != null &&
      typeof candidate === "object" &&
      typeof candidate.message === "string" &&
      (candidate.stdout == null ||
        (typeof candidate.stdout === "string" &&
          !JsonResponsePrefixPattern.test(candidate.stdout))) &&
      TransportFailurePattern.test(candidate.message)
    )
  }

  /**
   * True only when a failed clio push provably did not apply, so it may be sent again: its
   * connection failed, or clio returned a chain rejection in text or JSON — not an HTTP
   * failure after connecting, and not `Duplicate transaction`. Anything else, a killed clio
   * included, may have reached the node; its outcome is read from the chain instead.
   */
  export function isProvenUnapplied(error: unknown): boolean {
    const candidate = error as ClioError
    if (
      candidate == null ||
      typeof candidate !== "object" ||
      typeof candidate.message !== "string" ||
      (candidate.stdout != null && typeof candidate.stdout !== "string") ||
      candidate.killed === true ||
      candidate.signal != null
    ) {
      return false
    }
    const code = getChainErrorCode(candidate)
    return (
      isTransportFailure(candidate) ||
      (code != null &&
        code !== DuplicateTransactionCode &&
        !HttpExceptionPattern.test(candidate.message) &&
        !HttpExceptionPattern.test(`${ChainErrorCodePrefix}${code}:`))
    )
  }

  /**
   * Read a rejection code from clio's captured response, not a nested action trace or
   * console message. A JSON failure must identify the same transaction at both levels,
   * have no receipt, and not be scheduled. Successful or incomplete JSON never falls
   * back to scanning its embedded text as if it were a text-mode chain error.
   */
  function getChainErrorCode(error: ClioError): number {
    const response: unknown = getValue(() => JSON.parse(error.stdout), null)
    return match(response)
      .with(
        {
          transaction_id: P.string,
          processed: {
            id: P.string,
            receipt: null,
            scheduled: P.optional(false),
            except: {
              code: P.number
                .int()
                .between(ChainErrorCodeMinimum, ChainErrorCodeMaximum)
            }
          }
        },
        ({ transaction_id, processed }) =>
          transaction_id.length > 0 && transaction_id === processed.id
            ? processed.except.code
            : null
      )
      .with(P.nullish, () =>
        asOption(error.stdout)
          .filter(stdout => JsonResponsePrefixPattern.test(stdout))
          .match({
            Some: () => null,
            None: () =>
              asOption(ChainErrorCodePattern.exec(error.message))
                .map(([, digits]) => Number(digits))
                .getOrUndefined()
          })
      )
      .otherwise(() => null)
  }

  /**
   * Recognised clio / chain error fragments callers branch on. Substring-matched
   * against `err.message` / `err.stderr` — clio wraps the chain's assertion text
   * in CLI noise, so exact-match is not possible.
   */
  /**
   * NOT an identity enum (values are real error fragments, not their keys) →
   * a `const` per string-enum-value-equals-key.md.
   */
  export const ErrorFragment = {
    /** `sysio::newaccount` rejecting a name that is taken. */
    AccountAlreadyExists: "already exists",
    /** kiod refusing to unlock a wallet that is already unlocked. */
    WalletAlreadyUnlocked: "Already unlocked"
  } as const

  /** Cap on recorded result / error strings in `StepResult.extra` — full
   *  payloads ride the COMMAND line; outputs only need enough to identify
   *  the outcome without ballooning reports. */
  export const RecordStringCap = 600

  /** Truncate a string for an `extra` record, marking the cut. */
  export function truncateForRecord(value: string): string {
    return value.length > RecordStringCap
      ? `${value.slice(0, RecordStringCap)}… [truncated ${value.length - RecordStringCap} chars]`
      : value
  }

  /** The `receipt` slice of a clio transaction response (`processed.receipt`). */
  export interface TransactionReceipt {
    /** Chain execution status of the receipt, e.g. `"executed"`. */
    status?: string
  }

  /** The `processed` slice of a clio transaction response. */
  export interface TransactionProcessed {
    receipt?: TransactionReceipt
  }

  /**
   * The clio `-j` transaction-response fields {@link summarizeResult} keeps —
   * the same `transaction_id` field `WireClient.TransactionIdResponse`
   * carries, plus the receipt status. Every member is optional and read behind
   * a runtime `typeof` guard: this shape is duck-typed onto ARBITRARY clio
   * JSON, so a non-transaction response simply fails the guard.
   */
  export interface TransactionResult {
    transaction_id?: string
    processed?: TransactionProcessed
  }

  /**
   * The `extra`-record view of a clio result: a transaction response keeps its
   * id + receipt status; anything else is its (truncated) string form. The
   * INPUT payload already rides the recorded command line in full.
   */
  export function summarizeResult(result: unknown): unknown {
    if (result != null && typeof result === "object") {
      const candidate = result as TransactionResult
      if (typeof candidate.transaction_id === "string") {
        return {
          transaction_id: candidate.transaction_id,
          status: candidate.processed?.receipt?.status ?? null
        }
      }
      return truncateForRecord(JSON.stringify(result))
    }
    return truncateForRecord(String(result))
  }
}
