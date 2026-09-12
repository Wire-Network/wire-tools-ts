/**
 * SolanaAddAttestationTool — the ONE builder for the Solana outpost's
 * `liqsol_core::add_attestation` admin enqueue, shared by every harness tool
 * that drives a synthetic attestation onto the outpost's
 * `OutboundMessageBuffer` (`SolanaYieldEmitterTool` for STAKING_REWARD,
 * `SolanaSyndicationTool` for SYNDICATE_LIQ / LIQ_YIELD).
 *
 * The instruction is assembled BY HAND rather than through
 * `anchor.Program.methods.addAttestation(...)`: the IDL declares
 * `attestation_type` as a unit enum, but the proto-generated Rust
 * `AttestationType` (the `wire-opp-solana-models` crate, `types.rs`) carries a
 * custom `BorshSerialize` impl that writes it as an `i32` (4-byte LE). Anchor's
 * TS client would emit the IDL's 1-byte variant tag, which the program's
 * deserializer reads as a corrupted payload — including an OOM when the
 * proto-derived `from(i32)` tries to allocate a `Vec` over the misread length.
 * So the payload is built directly:
 *
 * ```
 * [ 8-byte Anchor discriminator ][ i32 LE attestation_type ][ u32 LE len ][ data ]
 * ```
 *
 * Every caller signs with the SOL outpost deployer keypair (==
 * `OutpostConfig.authority`, set during Phase 10b bootstrap, and the `admin`
 * recorded on the liqsol `GlobalConfig` the instruction checks `has_one`
 * against).
 */

import { createHash } from "node:crypto"
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js"
import { AttestationType } from "@wireio/opp-typescript-models"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { SolanaOutpostBootstrapper } from "../../orchestration/solana/SolanaOutpostBootstrapper.js"
import { SolanaOutpostProgramTool } from "./SolanaOutpostProgramTool.js"

export namespace SolanaAddAttestationTool {
  /** The liqsol_core instruction this tool invokes (Anchor snake_case name). */
  export const InstructionName = "add_attestation"

  /**
   * Anchor's global-instruction namespace prefix. An instruction's 8-byte
   * discriminator is `sha256("global:<instruction_name>")[0..8]` — the
   * convention every Anchor-generated client uses.
   */
  export const AnchorGlobalNamespacePrefix = "global:"

  /** Hash algorithm behind Anchor's instruction discriminator. */
  export const DiscriminatorHashAlgorithm = "sha256"

  /** Bytes of the Anchor instruction discriminator prefixed to the ix data. */
  export const DiscriminatorLength = 8

  /** Bytes of the `i32` LE `attestation_type` argument. */
  export const AttestationTypeLength = 4

  /** Bytes of Borsh's `u32` LE length prefix on a `Vec<u8>`. */
  export const VectorLengthPrefixLength = 4

  /**
   * The 8-byte Anchor discriminator for {@link InstructionName}.
   *
   * @returns The discriminator bytes.
   */
  export function instructionDiscriminator(): Buffer {
    return createHash(DiscriminatorHashAlgorithm)
      .update(`${AnchorGlobalNamespacePrefix}${InstructionName}`)
      .digest()
      .subarray(0, DiscriminatorLength)
  }

  /**
   * Borsh-encode the `add_attestation` instruction payload.
   *
   * @param attestationType - The attestation's proto enum value, written as
   *   `i32` LE to match the models crate's custom Borsh impl (NOT the IDL's
   *   variant tag).
   * @param data - The attestation message's encoded proto bytes.
   * @returns The complete instruction data buffer.
   */
  export function encodeInstructionData(
    attestationType: AttestationType,
    data: Uint8Array
  ): Buffer {
    const payload = Buffer.from(data),
      encoded = Buffer.alloc(
        DiscriminatorLength +
          AttestationTypeLength +
          VectorLengthPrefixLength +
          payload.length
      )
    let offset = 0
    instructionDiscriminator().copy(encoded, offset)
    offset += DiscriminatorLength
    encoded.writeInt32LE(attestationType, offset)
    offset += AttestationTypeLength
    encoded.writeUInt32LE(payload.length, offset)
    offset += VectorLengthPrefixLength
    payload.copy(encoded, offset)
    return encoded
  }

  /**
   * Build the `add_attestation` instruction. `AddAttestation` declares exactly
   * four accounts, IN THIS ORDER — `admin`, `global_config`, `config`,
   * `outbound_message_buffer` — and the keys below mirror that list. Seeds come
   * from the ONE registry ({@link SolanaOutpostBootstrapper.PdaSeed}); never
   * re-spell a seed literal at a call site.
   *
   * @param programId - The deployed `liqsol_core` program id.
   * @param authority - The outpost deployer / liqsol `admin` (the ix signer).
   * @param attestationType - The attestation's proto enum value.
   * @param data - The attestation message's encoded proto bytes.
   * @returns The assembled instruction.
   */
  export function createInstruction(
    programId: PublicKey,
    authority: PublicKey,
    attestationType: AttestationType,
    data: Uint8Array
  ): TransactionInstruction {
    const { PdaSeed } = SolanaOutpostBootstrapper,
      globalConfigPda = SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(PdaSeed.GlobalConfig)
      ),
      configPda = SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(PdaSeed.OutpostConfig)
      ),
      outboundMessageBufferPda = SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(PdaSeed.OutboundMessageBuffer)
      )
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: globalConfigPda, isSigner: false, isWritable: false },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: outboundMessageBufferPda, isSigner: false, isWritable: true }
      ],
      data: encodeInstructionData(attestationType, data)
    })
  }

  /**
   * Submit ONE `add_attestation` instruction and wait for its confirmation via
   * the shared bounded poller (anchor's `.rpc()` confirmation is unreliable in
   * the test-validator environment).
   *
   * @param connection - Solana RPC connection (typically `ctx.solana.connection`).
   * @param programId - The deployed `liqsol_core` program id.
   * @param authority - Deployer keypair == `OutpostConfig.authority` / liqsol `admin`.
   * @param attestationType - The attestation's proto enum value.
   * @param data - The attestation message's encoded proto bytes.
   * @param label - Confirmation label for log / error messages.
   * @returns The confirmed transaction signature.
   */
  export async function addAttestation(
    connection: Connection,
    programId: PublicKey,
    authority: Keypair,
    attestationType: AttestationType,
    data: Uint8Array,
    label: string
  ): Promise<string> {
    const transaction = new Transaction().add(
        createInstruction(programId, authority.publicKey, attestationType, data)
      ),
      signature = await connection.sendTransaction(transaction, [authority], {
        skipPreflight: false
      })
    await confirmSignature(connection, signature, label)
    return signature
  }
}
