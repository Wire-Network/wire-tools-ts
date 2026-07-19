/**
 * Program-derived-address seeds for the Solana OPP outpost hosted in
 * `liqsol_core`.
 *
 * Changing any string here (or letting a call site drift off this module)
 * breaks PDA derivation for every Solana outpost instruction — bootstrap,
 * collateral, swap, and yield emission. Values MUST stay byte-identical to
 * `wire-solana/programs/liqsol-core/src/states/opp_states.rs`.
 *
 * Prefer {@link SolanaOutpostPdaSeed.Bytes} at `findProgramAddressSync` call
 * sites so every consumer shares one precomputed buffer per seed.
 */
export namespace SolanaOutpostPdaSeed {
  /** Singleton `OutpostConfig` account seed. */
  export const OutpostConfig = "outpost_config"
  /** Singleton outbound attestation buffer seed. */
  export const OutboundMessageBuffer = "outbound_message_buffer"
  /** Singleton operator registry seed. */
  export const OperatorRegistry = "operator_registry"
  /** Inbound envelope log seed. */
  export const InboundEnvelopes = "inbound_envelopes"
  /** Outbound envelope log seed. */
  export const OutboundEnvelopes = "outbound_envelopes"
  /** Latest outbound envelope pointer seed. */
  export const LatestOutboundEnvelope = "latest_outbound_envelope"
  /** Aggregate reserve bookkeeping seed. */
  export const ReserveAggregate = "reserve_aggregate"
  /** Per-`(token_code, reserve_code)` reserve account seed. */
  export const Reserve = "reserve"
  /** Per-`(token_code, reserve_code)` SPL reserve vault seed. */
  export const ReserveVault = "reserve_vault"
  /** Native SOL collateral vault seed (`opp-outpost::deposit`). */
  export const OutpostVault = "outpost_vault"
  /** Per-`token_code` SPL collateral vault seed (`deposit_non_native`). */
  export const CollateralVault = "collateral_vault"

  /**
   * Precomputed UTF-8 seed buffers for `PublicKey.findProgramAddressSync`.
   * Identical to `Buffer.from` of the string constants above — kept here so
   * tools never redeclare the literal.
   */
  export namespace Bytes {
    export const OutpostConfig = Buffer.from(SolanaOutpostPdaSeed.OutpostConfig)
    export const OutboundMessageBuffer = Buffer.from(
      SolanaOutpostPdaSeed.OutboundMessageBuffer
    )
    export const OperatorRegistry = Buffer.from(
      SolanaOutpostPdaSeed.OperatorRegistry
    )
    export const InboundEnvelopes = Buffer.from(
      SolanaOutpostPdaSeed.InboundEnvelopes
    )
    export const OutboundEnvelopes = Buffer.from(
      SolanaOutpostPdaSeed.OutboundEnvelopes
    )
    export const LatestOutboundEnvelope = Buffer.from(
      SolanaOutpostPdaSeed.LatestOutboundEnvelope
    )
    export const ReserveAggregate = Buffer.from(
      SolanaOutpostPdaSeed.ReserveAggregate
    )
    export const Reserve = Buffer.from(SolanaOutpostPdaSeed.Reserve)
    export const ReserveVault = Buffer.from(SolanaOutpostPdaSeed.ReserveVault)
    export const OutpostVault = Buffer.from(SolanaOutpostPdaSeed.OutpostVault)
    export const CollateralVault = Buffer.from(
      SolanaOutpostPdaSeed.CollateralVault
    )
  }
}
