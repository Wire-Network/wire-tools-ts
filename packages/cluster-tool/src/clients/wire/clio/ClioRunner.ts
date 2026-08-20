import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { asOption } from "@3fv/prelude-ts"
import { getLogger } from "@wireio/shared"
import { negate } from "lodash"
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
export interface ClioRunOptionsJson<T extends object> extends ClioRunOptions<true> {
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
export function enrichClioError(error: unknown, stdout: string, stderr: string): unknown {
  const candidate = error as ClioError
  if (candidate != null && typeof candidate === "object" && typeof candidate.message === "string") {
    candidate.message = [candidate.message, stdout, stderr].filter(isNotEmpty).join("\n")
  }
  return error
}

/**
 * Private `execFile` transport for the `clio` CLI — the only surface other
 * `clients/wire` files use to shell out to clio. Folds chain-side rejection
 * detail into thrown errors via {@link enrichClioError}.
 */
export class ClioRunner {
  constructor(readonly config: ClioRunnerConfig) {}

  /** Run a clio command, returning parsed JSON. */
  run<T extends object>(args: string[], options: ClioRunOptionsJson<T>): Promise<T>
  /** Run a clio command, returning raw stdout. */
  run(args: string[], options?: ClioRunOptions): Promise<string>
  async run(args: string[], options: ClioRunOptions | ClioRunOptionsJson<any> = { json: false }): Promise<any> {
    const fullArgs = [
      "-u",
      this.config.nodeopUrl,
      ...(this.config.kiodUrl ? ["--wallet-url", this.config.kiodUrl] : []),
      ...args
    ]
    log.debug("clio %s", fullArgs.join(" "))
    // TRANSPORT retries only: a connection-level failure (refused / reset under
    // host connection churn — the node itself keeps serving). A NON-transport
    // error IS the result (rethrown).
    //
    // ⚠️ The safety argument here is NOT uniform across the patterns, and the
    // claim this comment used to make — "a re-pushed duplicate surfaces as the
    // benign `tx_duplicate`" — is FALSE for `clio push action`. clio re-SIGNS
    // with fresh TAPOS, so a re-run is a NEW transaction with a NEW id, which
    // the chain has no way to dedupe. Run-5 (2026-08-04) demonstrates it: one
    // logical `newaccount` produced a400888817 → 8d8cfc45 → c5bc6523.
    //
    // The patterns split by WHEN they can occur:
    //   pre-submission  `Connection refused` / `couldn't connect to server` —
    //                   nothing reached the node; re-running is genuinely safe.
    //   ambiguous       `Connection reset` / `Failed http request to nodeop` —
    //                   the node may have ACCEPTED the transaction before the
    //                   socket died, so a re-run can double-apply it.
    // The ambiguous class belongs in the same "unknown → do not re-send" bucket
    // as an unresolved finality wait (see WireClient.withFinality). Narrowing it
    // is a behavioural change with its own blast radius and is NOT made here;
    // this note exists so the next reader does not inherit the false premise.
    // Every logical clio invocation — command line, outcome, duration — is
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
        error: ClioRunner.truncateForRecord(error instanceof Error ? error.message : String(error))
      })
      throw error
    }
  }

  /** One clio subprocess execution (the retry loop above owns transport failures). */
  private async runOnce(fullArgs: string[], options: ClioRunOptions | ClioRunOptionsJson<any>): Promise<any> {
    try {
      const { stdout, stderr } = await execFileAsync(this.config.binary, fullArgs, {
        maxBuffer: ClioRunner.MaxBuffer,
        timeout: ClioRunner.CommandTimeoutMs
      })
      asOption(stderr)
        .filter(isNotEmpty)
        .match({
          Some: text => log.warn("clio stderr: %s", text),
          None: () => null
        })
      if (options.json) {
        try {
          return JSON.parse(stdout)
        } catch {
          return stdout.trim()
        }
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

  /** clio's connection-level failure signatures (transport, not chain rejection). */
  export const TransportFailurePattern =
    /Failed http request to nodeop|Connection refused|Connection reset|couldn't connect to server/i

  /** True when `error` is a connection-level clio failure (safe to re-run). */
  export function isTransportFailure(error: unknown): boolean {
    const candidate = error as ClioError
    return (
      candidate != null &&
      typeof candidate === "object" &&
      typeof candidate.message === "string" &&
      TransportFailurePattern.test(candidate.message)
    )
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
