/**
 * SolanaAnchorScriptTool — the ONE way the harness runs a wire-solana
 * `[scripts]` entry from `Anchor.toml`.
 *
 * The liqsol surface (mint, transfer hook, distribution/stake state,
 * leaderboard, withdraw + wire config, reserve pool, treasury) is
 * stood up by wire-solana's own `init-*` scripts — the same scripts
 * `bash-scripts/reset-local-cluster.sh` drives for a developer's local cluster.
 * The harness runs each of them as its own {@link ClusterBuildStep} so the
 * Report records every one, exactly as `EthereumOutpostBootstrapper` shells out
 * to hardhat for the Ethereum deploy.
 *
 * `anchor run <script> --provider.cluster <rpc> --provider.wallet <keypair>`
 * populates `ANCHOR_PROVIDER_URL` / `ANCHOR_WALLET`, which is what every script
 * reads through `AnchorProvider.env()`. The harness NEVER runs
 * `reset-local-cluster.sh` itself: its `anchor deploy` would fight the genesis
 * program load (a different upgrade authority), and its mint-address rewrite no
 * longer exists (the liqSOL mint is a PDA).
 *
 * TWO properties of `anchor run` this tool has to defend against:
 *
 * 1. **It resolves the script's interpreter off PATH.** Every `[scripts]` entry
 *    is a bare `ts-node scripts/…`, which anchor-cli hands to `bash -c` with the
 *    caller's environment — it does NOT prepend the workspace's
 *    `node_modules/.bin`. A machine with a global `ts-node` masks this; a CI
 *    runner has none and every script dies `command not found`. {@link runScript}
 *    therefore prepends {@link NodeBinSubdirectory} to `PATH`, so the `ts-node`
 *    that runs is the one wire-solana's lockfile pins.
 * 2. **It applies `Anchor.toml`'s `[toolchain]` on EVERY invocation.** Since
 *    anchor-cli 0.30, a `solana_version` / `anchor_version` that differs from
 *    what is installed triggers an `agave-install init <version>` — a network
 *    download that flips `~/.local/share/solana/install/active_release` out from
 *    under the `solana-test-validator` this cluster is running. The bootstrap
 *    refuses to start the surface on a mismatch rather than discover it that
 *    way: see `SolanaLiqsolSurfaceSteps.assertToolchainMatchesPins`.
 */

import { execFile } from "node:child_process"
import Path from "node:path"
import { promisify } from "node:util"

import { NestedError } from "@wireio/shared"

import { SolanaFundingTool } from "./SolanaFundingTool.js"
import { getLogger } from "../../logging/Logger.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"

const log = getLogger(__filename)

const execFileAsync = promisify(execFile)

export namespace SolanaAnchorScriptTool {
  /** Input for {@link planRun} — one `anchor run <script>` invocation. */
  export interface RunInput extends StepInput {
    readonly kind: "SolanaAnchorScriptTool.RunInput"
    /** The `Anchor.toml` `[scripts]` key to run (e.g. `init-global-config`). */
    readonly script: string
    /** Positional arguments forwarded to the script after `--`. */
    readonly scriptArgs: ReadonlyArray<string>
  }

  /**
   * A single `anchor run <script>` against this cluster's validator, signed by
   * the per-cluster deployer (the programs' upgrade authority and the liqsol
   * `global_config.admin`).
   *
   * A DOCUMENTED DEPARTURE from "one write per Step": a script Step may carry N
   * transactions, and the Report records the SCRIPT, not each transaction — the
   * same departure `EthereumOutpostBootstrapper`'s hardhat shell-out makes for
   * the Ethereum deploy. `init-validator-leaderboard`, for example, submits a
   * realloc chain as one row. The step's evidence
   * is its captured stdout/stderr, not a per-transaction trace. When a specific
   * instruction needs its own Report row, drive it as a harness Step through
   * `SolanaOutpostProgramTool.loadProgram` instead of adding it here.
   *
   * A script behind this tool must satisfy TWO properties, and a script that
   * fails either one belongs in a harness Step instead — one that reads the
   * account first and performs the single write
   * (`SolanaLiqsolSurfaceSteps.planFundTreasury` is the worked example):
   *
   * 1. **Get-or-create.** It reads its target account and returns when it
   *    already exists, so a re-run against a partially-initialized cluster is
   *    safe. A plain transfer or a counter bump is not.
   * 2. **It exits non-zero on failure.** The exit code is ALL this tool sees —
   *    a script whose entry point is `main().catch(console.error)` prints its
   *    error and exits 0, so its Step goes green on a failed write and the
   *    damage surfaces steps later, under the wrong name.
   *
   * @param actor - The narrative subject (the Solana outpost).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param script - The `Anchor.toml` `[scripts]` key to run.
   * @param scriptArgs - Positional arguments forwarded after `--`.
   * @returns The definition step.
   */
  export function planRun<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    script: string,
    scriptArgs: ReadonlyArray<string> = []
  ): ClusterBuildStep<C, RunInput> {
    return ClusterBuildStep.create<C, RunInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaAnchorScriptTool.RunInput", script, scriptArgs },
      runScript
    )
  }

  /** Named runner — ONE `anchor run` subprocess, its output folded into the step extra. */
  export async function runScript<C extends ClusterBuildContext>(
    ctx: C,
    input: RunInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const walletFile = SolanaFundingTool.deployerKeypairFile(
        ctx.config.dataPath
      ),
      args = buildArgs(
        input.script,
        input.scriptArgs,
        ctx.solana.rpcUrl,
        walletFile
      )
    StepExtraRecorder.record({
      client: "process",
      kind: "exec",
      command: [Executable, ...args],
      cwd: ctx.config.solanaPath
    })
    const { stdout, stderr } = await execFileAsync(Executable, args, {
      cwd: ctx.config.solanaPath,
      env: scriptEnvironment(ctx.config.solanaPath),
      timeout: scaleTimeoutMs(ScriptTimeoutMs),
      maxBuffer: OutputBufferBytes,
      signal
    }).catch(error => {
      throw new NestedError(
        `SolanaAnchorScriptTool: 'anchor run ${input.script}' failed`,
        {
          cause: error,
          context: {
            script: input.script,
            cwd: ctx.config.solanaPath,
            rpcUrl: ctx.solana.rpcUrl,
            wallet: walletFile,
            stdout: tail(error.stdout),
            stderr: tail(error.stderr)
          }
        }
      )
    })
    // A PASSING step's evidence belongs in the Report, not in a log line the
    // default level drops. Without this the only surviving record of what a
    // script did would be the argv that launched it — so `init-wire-config`
    // standing up the wire `GlobalState` and the liqSOL pool's accounting, for
    // instance, would be unverifiable after the run.
    StepExtraRecorder.record(outputExtra(input.script, stdout, stderr))
    // The tails are DEBUG, not INFO: twenty scripts x 4 000 chars would flood
    // the cluster aggregate log the heartbeat monitor greps on every bootstrap.
    // The failure path keeps both tails on the NestedError's context.
    if (stderr)
      log.debug(`[anchor run ${input.script}] stderr:\n${tail(stderr)}`)
    log.debug(`[anchor run ${input.script}] stdout:\n${tail(stdout)}`)
    log.info(`ran 'anchor run ${input.script}'`)
  }

  /**
   * The environment an `anchor run` subprocess gets: the caller's, with
   * wire-solana's own `node_modules/.bin` FIRST on `PATH`.
   *
   * Every `[scripts]` entry names a bare `ts-node`, and anchor-cli resolves it
   * off PATH without adding the workspace bin dir. Prepending it means the
   * interpreter is the one that repo's lockfile pins — the difference between
   * "works on a box with a global ts-node" and "works", and on a machine that
   * has both, the difference between wire-solana's pinned version and whatever
   * the global shim happens to be.
   *
   * POSIX only, as is the whole harness (it spawns `nodeop`,
   * `solana-test-validator` and `anvil`): `PATH` is the only spelling handled,
   * not Windows' case-insensitive `Path`.
   *
   * A pure value helper: unit-testable without spawning anything.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @returns The environment to hand the subprocess.
   */
  export function scriptEnvironment(solanaPath: string): NodeJS.ProcessEnv {
    const binPath = Path.join(solanaPath, NodeBinSubdirectory),
      { PATH: inherited = "" } = process.env
    return {
      ...process.env,
      // No trailing delimiter when nothing is inherited: POSIX reads an empty
      // PATH entry as the CURRENT DIRECTORY, which is not something a script
      // subprocess should be able to resolve a binary from.
      PATH: inherited ? `${binPath}${Path.delimiter}${inherited}` : binPath
    }
  }

  /**
   * The `anchor run` argv (WITHOUT the binary) — a pure value helper, so the
   * flag order is unit-testable without spawning anything.
   *
   * @param script - The `Anchor.toml` `[scripts]` key.
   * @param scriptArgs - Positional arguments forwarded after `--`.
   * @param rpcUrl - The cluster validator's RPC URL (`--provider.cluster`).
   * @param walletFile - The signing keypair file (`--provider.wallet`).
   * @returns The argv.
   */
  export function buildArgs(
    script: string,
    scriptArgs: ReadonlyArray<string>,
    rpcUrl: string,
    walletFile: string
  ): string[] {
    return [
      RunSubcommand,
      script,
      ClusterFlag,
      rpcUrl,
      WalletFlag,
      walletFile,
      ...(scriptArgs.length > 0 ? [ArgumentSeparator, ...scriptArgs] : [])
    ]
  }

  /** The Anchor CLI, resolved from `PATH`. */
  export const Executable = "anchor"
  /** Anchor subcommand that runs an `Anchor.toml` `[scripts]` entry. */
  export const RunSubcommand = "run"
  /** Anchor's cluster override — becomes `ANCHOR_PROVIDER_URL` for the script. */
  export const ClusterFlag = "--provider.cluster"
  /** Anchor's wallet override — becomes `ANCHOR_WALLET` for the script. */
  export const WalletFlag = "--provider.wallet"
  /** Separator after which Anchor forwards positional arguments to the script. */
  export const ArgumentSeparator = "--"
  /**
   * Subprocess ceiling for ONE init script. Sized to the loaded-host worst case
   * (a cold `ts-node` compile plus a handful of confirmed transactions — the
   * leaderboard init alone submits a realloc chain), never to the dev-box
   * typical; a script that finishes in two seconds pays none of it.
   */
  export const ScriptTimeoutMs = 300_000
  /**
   * Where a wire-solana checkout keeps the executables its lockfile pins —
   * prepended to a script subprocess's `PATH` by {@link scriptEnvironment}.
   */
  export const NodeBinSubdirectory = Path.join("node_modules", ".bin")
  /** Subprocess stdout/stderr buffer cap (bytes). */
  export const OutputBufferBytes = 10 * 1_024 * 1_024
  /** Characters of a script's stdout/stderr retained in logs and error context. */
  export const OutputTailChars = 4_000

  /** Last {@link OutputTailChars} characters of a subprocess stream (`""` when empty). */
  function tail(output: string): string {
    return output ? output.slice(-OutputTailChars) : ""
  }

  /**
   * The recorded-output entry for a completed script — a pure value helper, so
   * the shape the Report carries is testable without spawning anything.
   *
   * The TAIL is what is kept, deliberately: a script's verdict is its last
   * lines (`Successfully initialized wire config.`, a transaction signature),
   * while its head is setup chatter.
   *
   * @param script - The `Anchor.toml` `[scripts]` key that ran.
   * @param stdout - The subprocess's full stdout.
   * @param stderr - The subprocess's full stderr.
   * @returns The entry to hand {@link StepExtraRecorder.record}.
   */
  export function outputExtra(
    script: string,
    stdout: string,
    stderr: string
  ): StepExtraRecorder.ClientCall {
    return {
      client: "process",
      kind: "exec-output",
      script,
      stdout: tail(stdout),
      stderr: tail(stderr)
    }
  }
}
