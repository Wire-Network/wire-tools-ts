import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"

/** OPP reserves the high bit of its payload-version byte. */
const MaximumPayloadVersion = 0x7f
/** Zero is an absent protobuf version, never a supported protocol. */
const MinimumPayloadVersion = 1
/** Nonempty sets describe every version a release can emit or receive. */
const PayloadVersionSetSchema = z.array(
  z.number().int().min(MinimumPayloadVersion).max(MaximumPayloadVersion)
).nonempty().refine(values => new Set(values).size === values.length, "duplicate payload version")

/** Operator-declared capabilities of the deployed OPP implementation. */
export const OppProtocolCapabilitiesSchema = z.object({
  /** Every MessagePayload version this deployment can send. */
  emit: PayloadVersionSetSchema,
  /** Every MessagePayload version this deployment can interpret. */
  receive: PayloadVersionSetSchema
})
/** Validated capabilities, shared by external configuration and activation checks. */
export type OppProtocolCapabilities = z.infer<typeof OppProtocolCapabilitiesSchema>
/** Codec for standalone capability records. */
export const OppProtocolCapabilitiesSchemaCodec =
  SchemaCodec.create<OppProtocolCapabilities>(OppProtocolCapabilitiesSchema)

/** Release manifest capability matrix; package/model versions do not imply protocol compatibility. */
export const OppProtocolManifestSchema = z.object({
  /** Schema version of this metadata document, independent of MessagePayload.version. */
  schemaVersion: z.literal(1),
  depot: OppProtocolCapabilitiesSchema,
  ethereum: OppProtocolCapabilitiesSchema,
  solana: OppProtocolCapabilitiesSchema
})
/** Complete reviewed release declaration. */
export type OppProtocolManifest = z.infer<typeof OppProtocolManifestSchema>
/** Shared release/deployment manifest validator. */
export const OppProtocolManifestSchemaCodec = SchemaCodec.create<OppProtocolManifest>(OppProtocolManifestSchema)

/** Current release declarations and directed compatibility validation. */
export namespace OppProtocolCapabilities {
  /** Current implementation on all three chains; changing it requires receiver-first rollout. */
  export const Current: OppProtocolCapabilities = { emit: [1], receive: [1] }

  /** Reviewed local capability matrix, mirrored by the platform manifest declaration. */
  export const CurrentManifest: OppProtocolManifest = {
    schemaVersion: 1,
    depot: Current,
    ethereum: Current,
    solana: Current
  }

  /**
   * Refuse a route unless the receiver understands EVERY version the sender may emit.
   * Metadata is an operator declaration, not a probe of live deployed bytecode.
   *
   * @param sender - Source implementation's declared capability set.
   * @param receiver - Destination implementation's declared capability set.
   * @param route - Human-readable source and destination for the refusal.
   * @returns Nothing when compatible; throws before activation otherwise.
   */
  export function assertCompatible(
    sender: OppProtocolCapabilities,
    receiver: OppProtocolCapabilities,
    route: string
  ): void {
    if (!OppProtocolCapabilitiesSchemaCodec.check(sender) ||
        !OppProtocolCapabilitiesSchemaCodec.check(receiver)) {
      throw new Error(`OPP capabilities missing or malformed: ${route}`)
    }
    const unsupported = sender.emit.filter(version => !receiver.receive.includes(version))
    if (unsupported.length > 0) {
      throw new Error(`Incompatible OPP payload versions on ${route}: ${unsupported.join(", ")}`)
    }
  }
}
