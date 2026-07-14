/**
 * SolanaOutpostProgramTool — single source of truth for the wire-solana
 * artifact layout of the Solana OPP outpost program. Since the clean-room
 * rewrite the outpost interface is hosted INSIDE the `liqsol_core` Anchor
 * program (`wire-solana/programs/liqsol-core/src/instructions/opp/`): the
 * compiled `.so`, the generated IDL, and the committed program keypair all
 * carry the `liqsol_core` name. Every harness consumer (validator preload,
 * outpost bootstrapper, daemon artifact preparation, flow Anchor loads)
 * resolves those artifacts through THIS namespace, never via hand-joined
 * paths.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type * as anchor from "@coral-xyz/anchor"
import { Keypair, type PublicKey } from "@solana/web3.js"

export namespace SolanaOutpostProgramTool {
  /**
   * Anchor program hosting the OPP outpost interface — the `metadata.name` of
   * the generated IDL. Passed to nodeop's `--solana-outpost-program-name` so
   * `outpost_solana_client_plugin` accepts the IDL (its compiled-in default
   * expects the pre-cleanroom standalone `opp_outpost` program; see
   * `wire-sysio/plugins/outpost_solana_client_plugin/include/sysio/outpost_solana_client_plugin.hpp`).
   */
  export const ProgramName = "liqsol_core"
  /**
   * Subpath (under `wire-solana`) of the committed program keypair. Its pubkey
   * equals the program's `declare_id!` — the validator preloads the `.so` at
   * exactly this address via `--bpf-program`.
   */
  export const ProgramKeypairSubpath = ".keys/liqsol_core-keypair.json"
  /** Subpath (under `wire-solana`) of the compiled program `.so`. */
  export const ProgramSoSubpath = "target/deploy/liqsol_core.so"
  /**
   * Subpath (under `wire-solana`) of the generated Anchor IDL. Only valid
   * after `anchor build` FOLLOWED BY `node scripts/opp/patch-idl-errors.js`
   * (Anchor 0.31 emits a broken `errors` array otherwise — the OPP codes
   * 6000-6056 the daemons surface would be missing).
   */
  export const ProgramIdlSubpath = "target/idl/liqsol_core.json"
  /** Remediation hint appended to every missing-artifact assertion. */
  export const BuildRemediationHint =
    "(run 'anchor build && node scripts/opp/patch-idl-errors.js' in wire-solana)"

  /** Absolute path of the committed program keypair under `solanaPath`. */
  export function programKeypairFile(solanaPath: string): string {
    return Path.join(solanaPath, ProgramKeypairSubpath)
  }

  /** Absolute path of the compiled program `.so` under `solanaPath`. */
  export function programSoFile(solanaPath: string): string {
    return Path.join(solanaPath, ProgramSoSubpath)
  }

  /** Absolute path of the generated program IDL under `solanaPath`. */
  export function programIdlFile(solanaPath: string): string {
    return Path.join(solanaPath, ProgramIdlSubpath)
  }

  /**
   * Program id derived from the committed program keypair, or `null` when the
   * keypair file is absent (tolerant path — callers that can proceed without
   * the program guard with `!= null`; {@link assertProgramId} is the throwing
   * form).
   */
  export function programId(solanaPath: string): PublicKey {
    const keypairFile = programKeypairFile(solanaPath)
    if (!Fs.existsSync(keypairFile)) return null
    const secretKey = Uint8Array.from(JSON.parse(Fs.readFileSync(keypairFile, "utf8")))
    return Keypair.fromSecretKey(secretKey).publicKey
  }

  /** Program id derived from the committed program keypair; throws when absent. */
  export function assertProgramId(solanaPath: string): PublicKey {
    const id = programId(solanaPath)
    Assert.ok(
      id != null,
      `SolanaOutpostProgramTool: ${ProgramName} program keypair missing: ` +
        `${programKeypairFile(solanaPath)} ${BuildRemediationHint}`
    )
    return id
  }

  /** Parse the generated program IDL; throws when the file is absent. */
  export function readIdl(solanaPath: string): anchor.Idl {
    const idlFile = programIdlFile(solanaPath)
    Assert.ok(
      Fs.existsSync(idlFile),
      `SolanaOutpostProgramTool: ${ProgramName} IDL missing: ${idlFile} ${BuildRemediationHint}`
    )
    return JSON.parse(Fs.readFileSync(idlFile, "utf8")) as anchor.Idl
  }
}
