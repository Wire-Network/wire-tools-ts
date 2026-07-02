import Fs from "node:fs"
import Path from "node:path"
import Assert from "node:assert"
import { Keypair } from "@solana/web3.js"
import { SolanaValidatorProcess } from "../../../cluster/processes/SolanaValidatorProcess.js"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"

/** Steps that manage the cluster's solana-test-validator process. */
export namespace SolanaValidatorProcessSteps {
  /** Subpath (under `wire-solana`) of the opp-outpost program keypair. */
  const ProgramKeypairSubpath = "wallets/opp-outpost-keypair.json"
  /** Subpath (under `wire-solana`) of the compiled opp-outpost `.so`. */
  const ProgramSoSubpath = "target/deploy/opp_outpost.so"
  /** opp-outpost program name (`--bpf-program`). */
  const ProgramName = "opp_outpost"
  /** Subpath (under the cluster data dir) for the validator ledger. */
  const LedgerSubpath = "solana-ledger"

  /**
   * Start the solana-test-validator (get-or-create from `ctx.processManager`)
   * with the `opp-outpost` program loaded via `--bpf-program` (the SOL outpost
   * deploy depends on it). Idempotent.
   */
  export function start<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runStart)
  }

  /** Named runner — get-or-create the {@link SolanaValidatorProcess} and start it. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.processManager.get(SolanaValidatorProcess.ProcessLabel) != null) return

    const programKeypairFile = Path.join(ctx.config.solanaPath, ProgramKeypairSubpath)
    Assert.ok(
      Fs.existsSync(programKeypairFile),
      `opp-outpost program keypair missing: ${programKeypairFile} (run 'anchor build -p opp-outpost')`
    )
    const programId = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(programKeypairFile, "utf8")))
    ).publicKey.toBase58()
    const soFile = Path.join(ctx.config.solanaPath, ProgramSoSubpath)

    const validator = await SolanaValidatorProcess.create(ctx.processManager, {
      rpcPort: ctx.config.bind.solana.ports.http,
      faucetPort: ctx.config.bind.solana.ports.faucet,
      ledgerPath: Path.join(ctx.config.dataPath, LedgerSubpath),
      programs: [{ name: ProgramName, programId, soFile }]
    })
    await validator.start()
  }
}
