import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { asOption } from "@3fv/prelude-ts"
import { getLogger } from "@wireio/shared"
import { negate } from "lodash"
import { StepExtraRecorder } from "../../../report/tools/StepExtraRecorder.js"
import { retry } from "../../../utils/asyncUtils.js"
import { isNotEmpty } from "../../../utils/predicateUtils.js"

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
export interface ClioRunOptionsJson<T extends {}> extends ClioRunOptions<true> {
  ctor?: new (data: any) => T
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
  const candidate = error as { message?: unknown }
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

/**
 * Private `execFile` transport for the `clio` CLI — the only surface other
 * `clients/wire` files use to shell out to clio. Folds chain-side rejection
 * detail into thrown errors via {@link enrichClioError}.
 */
export class ClioRunner {
  constructor(readonly config: ClioRunnerConfig) {}

  /** Run a clio command, returning parsed JSON. */
  run<T extends {}>(args: string[], options: ClioRunOptionsJson<T>): Promise<T>
  /** Run a clio command, returning raw stdout. */
  run(args: string[], options?: { json?: false }): Promise<string>
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
    // TRANSPORT retries only: a connection-level failure (refused / reset under
    // host connection churn — the node itself keeps serving) never reached chain
    // processing, so re-running is safe (a re-pushed duplicate surfaces as the
    // benign `tx_duplicate`). A NON-transport error IS the result (rethrown).
    // Every logical clio invocation — command line, outcome, duration — is
    // recorded into the running step's `Report.StepResult.extra`.
    const startedAtMs = Date.now(),
      command = [this.config.binary, ...fullArgs]
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
    const candidate = error as { message?: unknown }
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

  /**
   * The `extra`-record view of a clio result: a transaction response keeps its
   * id + receipt status; anything else is its (truncated) string form. The
   * INPUT payload already rides the recorded command line in full.
   */
  export function summarizeResult(result: unknown): unknown {
    if (result != null && typeof result === "object") {
      const candidate = result as {
        transaction_id?: unknown
        processed?: { receipt?: { status?: unknown } }
      }
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
