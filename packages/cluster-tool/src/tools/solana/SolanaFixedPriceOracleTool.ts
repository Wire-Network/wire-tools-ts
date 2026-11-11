import Assert from "node:assert/strict"
import * as ChildProcess from "node:child_process"
import Fs from "node:fs"
import { findPackageJSON } from "node:module"
import Path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { PublicKey } from "@solana/web3.js"
import { NestedError } from "@wireio/shared"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import type { SolanaValidatorProgram } from "../../cluster/processes/SolanaValidatorProcess.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildStep } from "../../orchestration/ClusterBuildStep.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"

/** Local-only Chainlink CPI fixture; the outpost itself uses its normal build. */
export namespace SolanaFixedPriceOracleTool {
  /** Identities the normal liqsol-core build validates at tranche initialization. */
  export const ProgramId = new PublicKey(
    "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
  )
  export const FeedId = new PublicKey(
    "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"
  )
  /** Per-cluster fixture artifacts survive for run/start.sh and never touch a shared build tree. */
  export const ArtifactSubdirectory = "solana-fixed-price-oracle"
  export const ProgramFilename = "wire_fixed_price_oracle.so"
  export const FeedFilename = "feed.json"
  export const BuildExecutable = "cargo-build-sbf"
  export const BuildTimeoutMs = 900_000
  export const OutputBufferBytes = 10 * 1_024 * 1_024
  export const OutputTailChars = 4_000

  /** Resolve the source from the installed package, including pnpm and published layouts. */
  export function sourceDirectory(): string {
    const packageFile = findPackageJSON(pathToFileURL(__filename))
    Assert.ok(packageFile, "Unable to locate the cluster-tool package manifest")
    return Path.join(
      Path.dirname(packageFile),
      "resources",
      "fixed-price-oracle"
    )
  }

  /** Stable cluster-local paths used by preparation and both validator launch paths. */
  export function artifactDirectory(config: ClusterConfig): string {
    return Path.join(config.dataPath, ArtifactSubdirectory)
  }

  /** Reject installation outside an explicitly enabled local-validator cluster. */
  export function assertLocalFixture(config: ClusterConfig): void {
    Assert.ok(
      config.enableSolanaFixedPriceOracle && config.externalOutposts == null,
      "The fixed-price oracle is only available to opted-in local validator clusters"
    )
  }

  /** Program definition for validator genesis (the mock cannot be upgraded remotely). */
  export function program(config: ClusterConfig): SolanaValidatorProgram {
    assertLocalFixture(config)
    return {
      name: "fixed-price-oracle",
      programId: ProgramId.toBase58(),
      soFile: Path.join(artifactDirectory(config), ProgramFilename)
    }
  }

  /** Feed preload flags, identical for live startup and rendered start.sh. */
  export function accountArgs(config: ClusterConfig): string[] {
    if (!config.enableSolanaFixedPriceOracle) return []
    assertLocalFixture(config)
    return [
      "--account",
      FeedId.toBase58(),
      Path.join(artifactDirectory(config), FeedFilename)
    ]
  }

  /** One SBF compiler process, recorded separately from account preparation and validator start. */
  export function planBuild<C extends ClusterBuildContext>(
    actor: Report.Actor
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      "build-fixed-price-oracle",
      "compile the local $100 Chainlink CPI fixture",
      { timeoutMs: BuildTimeoutMs },
      null,
      runBuild
    )
  }

  /** Compile only the oracle fixture; production wire-solana artifacts are read-only inputs. */
  export async function runBuild<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertLocalFixture(ctx.config)
    const source = sourceDirectory(),
      target = artifactDirectory(ctx.config)
    Assert.ok(
      Fs.existsSync(Path.join(source, "Cargo.lock")),
      "Fixed-price oracle Cargo sources are missing from @wireio/cluster-tool"
    )
    Fs.mkdirSync(target, { recursive: true })
    const args = [
      "--manifest-path",
      Path.join(source, "Cargo.toml"),
      "--sbf-out-dir",
      target,
      "--arch",
      "v3",
      "--",
      "--locked"
    ]
    StepExtraRecorder.record({
      client: "process",
      kind: "exec",
      command: [BuildExecutable, ...args],
      cwd: source
    })
    const { stdout, stderr } = await promisify(ChildProcess.execFile)(
      BuildExecutable,
      args,
      {
        cwd: source,
        signal,
        timeout: scaleTimeoutMs(BuildTimeoutMs),
        maxBuffer: OutputBufferBytes,
        env: { ...process.env, CARGO_TARGET_DIR: Path.join(target, "target") }
      }
    ).catch(error => {
      throw new NestedError("Building the local fixed-price oracle failed", {
        cause: error,
        context: {
          stdout: error.stdout?.slice(-OutputTailChars),
          stderr: error.stderr?.slice(-OutputTailChars)
        }
      })
    })
    StepExtraRecorder.record({
      client: "process",
      kind: "exec-output",
      script: "cargo-build-sbf fixed-price-oracle",
      stdout: stdout.slice(-OutputTailChars),
      stderr: stderr.slice(-OutputTailChars)
    })
    Assert.ok(
      Fs.existsSync(program(ctx.config).soFile),
      "cargo-build-sbf did not produce the fixed-price oracle program"
    )
  }

  /** Deterministic feed-account preparation, before the validator's first genesis. */
  export function planFeed<C extends ClusterBuildContext>(
    actor: Report.Actor
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      "prepare-fixed-price-feed",
      "preload the configured local Chainlink feed account",
      {},
      null,
      runFeed
    )
  }

  /** Write only the local genesis fixture; no transaction or remote endpoint is involved. */
  export async function runFeed<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertLocalFixture(ctx.config)
    const directory = artifactDirectory(ctx.config)
    Fs.mkdirSync(directory, { recursive: true })
    Fs.writeFileSync(
      Path.join(directory, FeedFilename),
      JSON.stringify({
        pubkey: FeedId.toBase58(),
        account: {
          lamports: 1_000_000,
          data: ["AA==", "base64"],
          owner: ProgramId.toBase58(),
          executable: false,
          rentEpoch: 0
        }
      })
    )
  }
}
