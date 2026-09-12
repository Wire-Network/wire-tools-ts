import { createHash } from "node:crypto"
import { PublicKey } from "@solana/web3.js"
import { AttestationType } from "@wireio/opp-typescript-models"
import { SolanaAddAttestationTool } from "@wireio/cluster-tool/tools/solana"

/**
 * The instruction contract mirrored here lives in
 * `wire-solana/programs/liqsol-core/src/instructions/opp/add_attestation.rs`
 * (the `AddAttestation` account struct) and the models crate's custom
 * `BorshSerialize for AttestationType` (`types.rs`), which writes the proto
 * enum as an `i32` rather than the IDL's 1-byte variant tag. Both halves of
 * that contract — the four-account order and the i32-LE argument — are
 * load-bearing and asserted independently below.
 */
describe("SolanaAddAttestationTool", () => {
  const programId = PublicKey.unique(),
    authority = PublicKey.unique(),
    /** An arbitrary non-empty payload — the encoder is content-agnostic. */
    payload = Uint8Array.of(0xde, 0xad, 0xbe, 0xef)

  describe("instructionDiscriminator", () => {
    it("is the first 8 bytes of sha256(\"global:add_attestation\")", () => {
      const expected = createHash("sha256")
        .update("global:add_attestation")
        .digest()
        .subarray(0, SolanaAddAttestationTool.DiscriminatorLength)
      expect(
        SolanaAddAttestationTool.instructionDiscriminator().equals(expected)
      ).toBe(true)
    })
  })

  describe("encodeInstructionData", () => {
    it("lays out discriminator + i32 LE type + u32 LE length + payload", () => {
      const encoded = SolanaAddAttestationTool.encodeInstructionData(
          AttestationType.SYNDICATE_LIQ,
          payload
        ),
        { DiscriminatorLength, AttestationTypeLength, VectorLengthPrefixLength } =
          SolanaAddAttestationTool
      expect(encoded.length).toBe(
        DiscriminatorLength +
          AttestationTypeLength +
          VectorLengthPrefixLength +
          payload.length
      )
      expect(
        encoded
          .subarray(0, DiscriminatorLength)
          .equals(SolanaAddAttestationTool.instructionDiscriminator())
      ).toBe(true)
      expect(encoded.readInt32LE(DiscriminatorLength)).toBe(
        AttestationType.SYNDICATE_LIQ
      )
      expect(
        encoded.readUInt32LE(DiscriminatorLength + AttestationTypeLength)
      ).toBe(payload.length)
      expect([
        ...encoded.subarray(
          DiscriminatorLength + AttestationTypeLength + VectorLengthPrefixLength
        )
      ]).toEqual([...payload])
    })

    it("encodes an empty payload as a zero length prefix and no data", () => {
      const encoded = SolanaAddAttestationTool.encodeInstructionData(
        AttestationType.LIQ_YIELD,
        new Uint8Array()
      )
      expect(encoded.length).toBe(
        SolanaAddAttestationTool.DiscriminatorLength +
          SolanaAddAttestationTool.AttestationTypeLength +
          SolanaAddAttestationTool.VectorLengthPrefixLength
      )
      expect(
        encoded.readUInt32LE(
          SolanaAddAttestationTool.DiscriminatorLength +
            SolanaAddAttestationTool.AttestationTypeLength
        )
      ).toBe(0)
    })

    it("distinguishes attestation types by the i32 cell alone", () => {
      const syndicate = SolanaAddAttestationTool.encodeInstructionData(
          AttestationType.SYNDICATE_LIQ,
          payload
        ),
        liqYield = SolanaAddAttestationTool.encodeInstructionData(
          AttestationType.LIQ_YIELD,
          payload
        )
      expect(syndicate.equals(liqYield)).toBe(false)
      expect(
        syndicate.readInt32LE(SolanaAddAttestationTool.DiscriminatorLength)
      ).not.toBe(
        liqYield.readInt32LE(SolanaAddAttestationTool.DiscriminatorLength)
      )
    })
  })

  describe("createInstruction", () => {
    it("declares admin, global_config, config, outbound_message_buffer IN ORDER", () => {
      const instruction = SolanaAddAttestationTool.createInstruction(
          programId,
          authority,
          AttestationType.SYNDICATE_LIQ,
          payload
        ),
        derive = (seed: string): string =>
          PublicKey.findProgramAddressSync(
            [Buffer.from(seed)],
            programId
          )[0].toBase58()
      expect(instruction.programId.toBase58()).toBe(programId.toBase58())
      expect(
        instruction.keys.map(key => key.pubkey.toBase58())
      ).toEqual([
        authority.toBase58(),
        derive("global_config"),
        derive("outpost_config"),
        derive("outbound_message_buffer")
      ])
    })

    it("marks only the admin as signer, and admin + buffer as writable", () => {
      const { keys } = SolanaAddAttestationTool.createInstruction(
        programId,
        authority,
        AttestationType.LIQ_YIELD,
        payload
      )
      expect(keys.map(key => key.isSigner)).toEqual([true, false, false, false])
      expect(keys.map(key => key.isWritable)).toEqual([
        true,
        false,
        false,
        true
      ])
    })

    it("carries the encoded instruction data verbatim", () => {
      const instruction = SolanaAddAttestationTool.createInstruction(
        programId,
        authority,
        AttestationType.DESYNDICATE_LIQ,
        payload
      )
      expect(
        instruction.data.equals(
          SolanaAddAttestationTool.encodeInstructionData(
            AttestationType.DESYNDICATE_LIQ,
            payload
          )
        )
      ).toBe(true)
    })
  })
})
