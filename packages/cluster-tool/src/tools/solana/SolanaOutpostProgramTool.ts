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
  /**
   * Subpath (under `wire-solana`) of the build manifest
   * `scripts/build/anchor-build-strict.mjs` writes beside the compiled `.so`s.
   * It records the SBPF arch the build targeted and each emitted binary's
   * sha256 — what {@link assertProgramSoFile} checks the deployed `.so` against.
   */
  export const BuildManifestSubpath = "target/deploy/wire-build-manifest.json"
  /**
   * Remediation hint appended to every missing-artifact assertion.
   *
   * `npm run build:programs`, NOT a bare `anchor build`: the wrapper is what
   * fails the build on an SBF frame overflow, emits each `.so` at the arch
   * `Anchor.toml`'s pinned toolchain implies, and writes
   * {@link BuildManifestSubpath}.
   */
  export const BuildRemediationHint =
    "(run 'npm run build:programs && node scripts/opp/patch-idl-errors.js' in wire-solana)"

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
   * @returns Absolute path of the verified `.so`.
   */
  export function assertProgramSoFile(solanaPath: string): string {
    const soFile = programSoFile(solanaPath)
    Assert.ok(
      Fs.existsSync(soFile),
      `SolanaOutpostProgramTool: ${ProgramName} .so missing: ${soFile} ${BuildRemediationHint}`
    )

    // Structural integrity first (is this manifest about this binary?), then
    // provenance (was that build made from these sources?) — so a malformed
    // manifest reports itself rather than surfacing as a checkout mismatch.
    const { arch, sourceDescribe, programs } = readBuildManifest(solanaPath),
      recorded = programs?.[ProgramName]
    Assert.ok(
      recorded != null,
      `SolanaOutpostProgramTool: build manifest has no ${ProgramName} entry: ` +
        `${buildManifestFile(solanaPath)} ${BuildRemediationHint}`
    )

    const actual = Crypto.createHash("sha256")
      .update(Fs.readFileSync(soFile))
      .digest("hex")
    Assert.ok(
      actual === recorded.programBinarySha256,
      `SolanaOutpostProgramTool: ${ProgramName} .so does not match the recorded ` +
        `SBPF ${arch} build — ${soFile} is sha256 ${actual}, manifest records ` +
        `${recorded.programBinarySha256}. The binary on disk was NOT produced by ` +
        `that build ${BuildRemediationHint}`
    )

    const currentDescribe = describeCheckout(solanaPath)
    Assert.ok(
      sourceDescribe === currentDescribe,
      `SolanaOutpostProgramTool: ${ProgramName} was built from a different checkout — ` +
        `manifest records "${sourceDescribe}", ${solanaPath} is now "${currentDescribe}". ` +
        `The binary predates the current sources ${BuildRemediationHint}`
    )
    if (sourceDescribe.endsWith(DirtyDescribeSuffix))
      log.warn(
        `${ProgramName} was built from a DIRTY checkout (${sourceDescribe}) — ` +
          `its provenance cannot be verified beyond the commit`
      )
    return soFile
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
    const secretKey = Uint8Array.from(
      JSON.parse(Fs.readFileSync(keypairFile, "utf8"))
    )
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
