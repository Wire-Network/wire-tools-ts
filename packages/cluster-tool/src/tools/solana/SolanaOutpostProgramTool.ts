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
import { execFileSync } from "node:child_process"
import Crypto from "node:crypto"
import Fs from "node:fs"
import Path from "node:path"
import { Either } from "@3fv/prelude-ts"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { getLogger, NestedError } from "@wireio/shared"

import { SolanaClient } from "../../clients/solana/SolanaClient.js"

const log = getLogger(__filename)

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
  /** Build stamp written by wire-solana for every deployable program. */
  export const BuildManifestSubpath = Path.join(
    DeploySubdirectory,
    "wire-build-manifest.json"
  )

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

  /** One program's entry in the wire-solana build manifest. */
  export interface BuildManifestProgram {
    /** Repo-relative path of the emitted binary. */
    programBinaryPath: string
    /** Byte length of the emitted binary. */
    programBinaryLength: number
    /** Hex sha256 of the emitted binary. */
    programBinarySha256: string
  }

  /** The build manifest emitted alongside the compiled `.so`s. */
  export interface BuildManifest {
    /** Manifest format version. */
    schemaVersion: number
    /** SBPF arch the `.so`s were built for (`v0`…`v3`). */
    arch: string
    /**
     * `git describe --tags --always --dirty` of the checkout the binaries were
     * built from — see {@link assertProgramSoFile} for why the sha pair alone
     * is not sufficient.
     */
    sourceDescribe: string
    /** Per-program entries, keyed by the program's snake_case name. */
    programs: Record<string, BuildManifestProgram>
  }

  /** Marker `git describe --dirty` appends when tracked files are modified. */
  export const DirtyDescribeSuffix = "-dirty"

  /**
   * `git describe --tags --always --dirty` of a checkout — the same value the
   * build records, so the two are directly comparable.
   *
   * @param repositoryPath - Repo root to describe.
   * @returns The describe string, e.g. `devnet-v1.5.2-237-g12f95d37-dirty`.
   */
  export function describeCheckout(repositoryPath: string): string {
    return Either.try(() =>
      execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
        cwd: repositoryPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    )
      .ifLeft(error => {
        throw new NestedError(
          "SolanaOutpostProgramTool: could not describe the wire-solana checkout",
          { cause: error, context: { repositoryPath } }
        )
      })
      .getOrThrow()
      .trim()
  }

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

  /** Absolute path of the build manifest under `solanaPath`. */
  export function buildManifestFile(solanaPath: string): string {
    return Path.join(solanaPath, BuildManifestSubpath)
  }

  /** Parse the wire-solana build manifest; throws when the file is absent. */
  export function readBuildManifest(solanaPath: string): BuildManifest {
    const manifestFile = buildManifestFile(solanaPath)
    Assert.ok(
      Fs.existsSync(manifestFile),
      `SolanaOutpostProgramTool: build manifest missing: ${manifestFile} ${BuildRemediationHint}`
    )
    return JSON.parse(Fs.readFileSync(manifestFile, "utf8")) as BuildManifest
  }

  /**
   * Absolute path of the compiled `.so`, PROVEN to be the binary the recorded
   * build emitted — called by `SolanaValidatorProcessSteps.runStart`, the one
   * path that actually loads the binary on THIS host. The `start.sh` renderer
   * takes the unverified {@link programSoFile} instead, because the script it
   * emits runs later and often elsewhere; see that step's JSDoc.
   *
   * The validator is launched with `--upgradeable-program <id> <soFile>`, so
   * whatever sits at that path IS what executes on chain. Existence alone is
   * not enough: nothing in the harness rebuilds the program, and `target/` is
   * git-ignored, so a `git checkout`/rebase moves the sources while the `.so`
   * stays put and a stale binary from another branch deploys silently.
   *
   * Comparing the file's sha256 against the manifest the build wrote turns that
   * into a startup error naming the mismatch. A wrong binary otherwise fails as
   * undefined behavior at instruction entry — observed 2026-08-21 as
   * `consumed 427 of 200000 compute units` / `Access violation writing 1 bytes
   * at address 0x32` during the outpost's init-PDAs step, which reads as a
   * program bug rather than a build-provenance one.
   *
   * The sha pair alone is NOT sufficient, because the `.so` and the manifest
   * are written together and both live in gitignored `target/`: a branch switch
   * leaves the pair behind intact and mutually consistent, so a sha-only check
   * passes while the sources have moved. `sourceDescribe` closes that — the
   * build stamps its `git describe` and this compares it against the current
   * checkout. A DIRTY build is reported rather than rejected: two different
   * dirty trees at one commit describe identically, so the stamp marks the
   * binary unverifiable instead of pretending otherwise.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param program - The program to verify (default: the OPP outpost host).
   * @returns Absolute path of the verified `.so`.
   */
  export function assertProgramSoFile(
    solanaPath: string,
    program: AnchorProgram = ProgramName
  ): string {
    const soFile = programSoFile(solanaPath, program)
    Assert.ok(
      Fs.existsSync(soFile),
      `SolanaOutpostProgramTool: ${program} .so missing: ${soFile} ${BuildRemediationHint}`
    )

    // Structural integrity first (is this manifest about this binary?), then
    // provenance (was that build made from these sources?) — so a malformed
    // manifest reports itself rather than surfacing as a checkout mismatch.
    const { arch, sourceDescribe, programs } = readBuildManifest(solanaPath),
      recorded = programs?.[program]
    Assert.ok(
      recorded != null,
      `SolanaOutpostProgramTool: build manifest has no ${program} entry: ` +
        `${buildManifestFile(solanaPath)} ${BuildRemediationHint}`
    )

    const actual = Crypto.createHash("sha256")
      .update(Fs.readFileSync(soFile))
      .digest("hex")
    Assert.ok(
      actual === recorded.programBinarySha256,
      `SolanaOutpostProgramTool: ${program} .so does not match the recorded ` +
        `SBPF ${arch} build — ${soFile} is sha256 ${actual}, manifest records ` +
        `${recorded.programBinarySha256}. The binary on disk was NOT produced by ` +
        `that build ${BuildRemediationHint}`
    )

    const currentDescribe = describeCheckout(solanaPath)
    Assert.ok(
      sourceDescribe === currentDescribe,
      `SolanaOutpostProgramTool: ${program} was built from a different checkout — ` +
        `manifest records "${sourceDescribe}", ${solanaPath} is now "${currentDescribe}". ` +
        `The binary predates the current sources ${BuildRemediationHint}`
    )
    if (sourceDescribe.endsWith(DirtyDescribeSuffix))
      log.warn(
        `${program} was built from a DIRTY checkout (${sourceDescribe}) — ` +
          `its provenance cannot be verified beyond the commit`
      )
    return soFile
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
