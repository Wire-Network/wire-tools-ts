/**
 * SolanaOutpostProgramTool — single source of truth for the wire-solana
 * artifact layout of EVERY Anchor program the cluster loads. Since the
 * clean-room rewrite the outpost interface is hosted INSIDE the `liqsol_core`
 * Anchor program (`wire-solana/programs/liqsol-core/src/instructions/opp/`),
 * so `liqsol_core` is this namespace's DEFAULT program; its three siblings
 * (`liqsol_token`, `transfer_hook`, `validator_leaderboard`) carry the liqsol
 * staking + syndication surface and resolve through the same functions by
 * passing their {@link SolanaOutpostProgramTool.AnchorProgram} crate name.
 *
 * Every artifact of every program follows ONE layout keyed by that crate name
 * — `.keys/<name>-keypair.json`, `target/deploy/<name>.so`,
 * `target/idl/<name>.json` — and every harness consumer (validator preload,
 * outpost bootstrapper, daemon artifact preparation, flow Anchor loads)
 * resolves them through THIS namespace, never via hand-joined paths.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"

import { SolanaClient } from "../../clients/solana/SolanaClient.js"

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
   * The wire-solana Anchor programs by CRATE name — the shared basename of
   * each program's `.keys` keypair, `target/deploy` `.so` and `target/idl`
   * JSON. Deliberately a `const` object rather than an enum: the values are
   * wire-solana's own crate spellings, not identity keys
   * (`string-enum-value-equals-key.md`).
   */
  export const AnchorProgram = {
    /** Hosts the OPP outpost interface AND the liqsol staking/syndication surface. */
    liqsolCore: ProgramName,
    /** Owns the liqSOL Token-2022 mint + its mint authority. */
    liqsolToken: "liqsol_token",
    /** The Token-2022 transfer hook the liqSOL mint delegates every transfer to. */
    transferHook: "transfer_hook",
    /** Validator leaderboard the liqsol staking surface reads + cranks. */
    validatorLeaderboard: "validator_leaderboard"
  } as const

  /** One wire-solana Anchor program's crate name (see {@link AnchorProgram}). */
  export type AnchorProgram = (typeof AnchorProgram)[keyof typeof AnchorProgram]

  /**
   * Every {@link AnchorProgram} the cluster's validator loads at genesis. All
   * four are required: `liqsol_core` alone gives an OPP outpost with NO liqsol
   * surface, so the `init-*` scripts that stand up the mint, the transfer hook,
   * the distribution/stake state and the leaderboard have nothing to
   * initialize against and every real `synd` / `report_liq_yield` path is
   * unreachable.
   */
  export const GenesisAnchorPrograms: ReadonlyArray<AnchorProgram> =
    Object.values(AnchorProgram)

  /** Subdirectory (under `wire-solana`) holding the committed program keypairs. */
  export const KeysSubdirectory = ".keys"
  /** Subdirectory (under `wire-solana`) holding the compiled program `.so` files. */
  export const DeploySubdirectory = Path.join("target", "deploy")
  /** Subdirectory (under `wire-solana`) holding the generated Anchor IDLs. */
  export const IdlSubdirectory = Path.join("target", "idl")
  /**
   * Remediation hint appended to every missing-artifact assertion.
   *
   * Names the wire-solana build the harness actually DEPLOYS, not a bare
   * `anchor build`: that repo's `build:programs` is what the platform gate runs
   * and what produces every `.so` + patched IDL this namespace resolves. A
   * hand-rolled `anchor build` can leave the tree in a state the harness cannot
   * bootstrap from.
   */
  export const BuildRemediationHint =
    "(run the wire-solana build the harness deploys: 'npm install && npm run build:programs' in wire-solana)"

  /**
   * Absolute path of a program's committed keypair under `solanaPath`. Its
   * pubkey equals the program's `declare_id!` — the validator preloads the
   * `.so` at exactly this address.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The absolute keypair file path.
   */
  export function programKeypairFile(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): string {
    return Path.join(solanaPath, KeysSubdirectory, `${program}-keypair.json`)
  }

  /**
   * Absolute path of a program's compiled `.so` under `solanaPath`.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The absolute `.so` file path.
   */
  export function programSoFile(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): string {
    return Path.join(solanaPath, DeploySubdirectory, `${program}.so`)
  }

  /**
   * Absolute path of a program's generated Anchor IDL under `solanaPath`. Only
   * valid after wire-solana's own `npm run build:programs`, which regenerates
   * the IDLs AND patches their `errors` array (Anchor 0.31 emits a broken one —
   * the OPP codes 6000-6056 the daemons surface would be missing).
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The absolute IDL file path.
   */
  export function programIdlFile(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): string {
    return Path.join(solanaPath, IdlSubdirectory, `${program}.json`)
  }

  /**
   * Program id derived from the committed program keypair, or `null` when the
   * keypair file is absent (tolerant path — callers that can proceed without
   * the program guard with `!= null`; {@link assertProgramId} is the throwing
   * form).
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The program id, or `null` when the keypair file is absent.
   */
  export function programId(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): PublicKey {
    const keypairFile = programKeypairFile(solanaPath, program)
    if (!Fs.existsSync(keypairFile)) return null
    const secretKey = Uint8Array.from(
      JSON.parse(Fs.readFileSync(keypairFile, "utf8"))
    )
    return Keypair.fromSecretKey(secretKey).publicKey
  }

  /**
   * Program id derived from the committed program keypair; throws when absent.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The program id.
   * @throws If the keypair file is absent.
   */
  export function assertProgramId(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): PublicKey {
    const id = programId(solanaPath, program)
    Assert.ok(
      id != null,
      `SolanaOutpostProgramTool: ${program} program keypair missing: ` +
        `${programKeypairFile(solanaPath, program)} ${BuildRemediationHint}`
    )
    return id
  }

  /**
   * Parse a generated program IDL; throws when the file is absent.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name (default: the OPP outpost host).
   * @returns The parsed IDL.
   * @throws If the IDL file is absent.
   */
  export function readIdl(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): anchor.Idl {
    const idlFile = programIdlFile(solanaPath, program)
    Assert.ok(
      Fs.existsSync(idlFile),
      `SolanaOutpostProgramTool: ${program} IDL missing: ${idlFile} ${BuildRemediationHint}`
    )
    return JSON.parse(Fs.readFileSync(idlFile, "utf8")) as anchor.Idl
  }

  /**
   * The program id an IDL DECLARES (`address`) — what `anchor run`'s scripts
   * resolve their program from, and what must equal the `.keys` id the
   * validator loaded the `.so` at.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program's crate name.
   * @returns The IDL-declared program id.
   * @throws If the IDL file is absent or declares no `address`.
   */
  export function assertIdlProgramId(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): PublicKey {
    const declared = readIdl(solanaPath, program).address
    Assert.ok(
      declared,
      `SolanaOutpostProgramTool: ${program} IDL declares no address: ` +
        `${programIdlFile(solanaPath, program)} ${BuildRemediationHint}`
    )
    return new PublicKey(declared)
  }

  /**
   * Build the OPP outpost Anchor `Program` (hosted in `liqsol_core`) bound to
   * `keypair` as its provider wallet — THE one `Program` construction for this
   * program. A pure value helper (IDL read + provider wiring, no chain call),
   * so it is called freely inside step runners and bootstrapper methods.
   *
   * @param connection - The Solana RPC connection the provider transacts over.
   * @param keypair - The signer the provider's wallet wraps.
   * @param solanaPath - The `wire-solana` repo root holding the generated IDL.
   * @returns The Anchor program bound to `connection` + `keypair`.
   * @throws If the generated IDL is missing (see {@link readIdl}).
   */
  export function loadProgram(
    connection: Connection,
    keypair: Keypair,
    solanaPath: string
  ): anchor.Program<anchor.Idl> {
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(keypair),
      { commitment: SolanaClient.DefaultCommitment }
    )
    return new anchor.Program(readIdl(solanaPath), provider)
  }

  /**
   * Build an Anchor `Program` bound to a CONNECTION-ONLY provider — everything
   * a READ needs (`coder.accounts.decode`, `methods…instruction()`) and no
   * wallet, keypair or signer. A pure value helper, called freely inside step
   * runners and verify steps.
   *
   * `anchor.Program` is what converts the IDL to camelCase, so its coder keys
   * accounts, fields and enum variants by their CAMELCASE spellings — the same
   * spellings {@link SolanaAnchorEnumTool} encodes instruction arguments with.
   * A bare `anchor.BorshCoder` over the raw IDL is NOT equivalent: it keys by
   * the IDL's own `GlobalState` / `snake_case` names, and Anchor exports no
   * converter to bridge the two. That is why a read builds a `Program` rather
   * than a coder.
   *
   * @param connection - The Solana RPC connection reads are issued over.
   * @param solanaPath - The `wire-solana` repo root holding the generated IDL.
   * @param program - The program's crate name.
   * @returns The Anchor program bound to `connection`, with no wallet.
   * @throws If the generated IDL is missing (see {@link readIdl}).
   */
  export function loadReadOnlyProgram(
    connection: Connection,
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): anchor.Program<anchor.Idl> {
    return new anchor.Program(readIdl(solanaPath, program), { connection })
  }

  /**
   * Derive a program-derived address from its ordered seeds — THE one PDA
   * derivation for this program. A pure read, so it is called freely inside
   * step runners and bootstrapper methods rather than being a Step.
   *
   * Seeds are passed in the program's own declared order; scoped legs
   * (`token_code`, `reserve_code`) are encoded with `slugNameToLittleEndianBuffer`
   * from `utils/slugUtils` to match the program's `to_le_bytes()`.
   *
   * @param programId - The deployed `liqsol_core` program id.
   * @param seeds - The ordered seed buffers.
   * @returns The derived program address.
   */
  export function derivePda(
    programId: PublicKey,
    ...seeds: Buffer[]
  ): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, programId)[0]
  }
}
