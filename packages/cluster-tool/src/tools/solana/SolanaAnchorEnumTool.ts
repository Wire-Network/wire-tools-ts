/**
 * Anchor IDL enum-variant tag helpers.
 *
 * The `@coral-xyz/anchor` TS client encodes Rust enum arguments as
 * single-key tagged-union objects whose key is the camelCased variant
 * identifier and whose value is `{}`. Passing a raw numeric enum value
 * makes the Borsh union encoder throw `Union.defaultGetSourceVariant`.
 *
 * Centralized here so every TS-side Anchor IX call against a `wire-solana`
 * program — the OPP outpost's operator/token enums and `liqsol_core`'s
 * `WireState` alike — reuses the same mapping rather than re-deriving it
 * ad-hoc.
 */

import { match } from "ts-pattern"
import { OperatorType, TokenKind } from "@wireio/opp-typescript-models"

/** Anchor variant-tag object — single key, empty payload. */
export type AnchorEnumVariant = Readonly<Record<string, Record<string, never>>>

/**
 * Convert a numeric `OperatorType` to the Anchor IDL variant-tag object
 * expected by a wire-solana instruction's args.
 *
 * @param t Numeric operator type (e.g. `OperatorType.BATCH`).
 * @return  Variant-tag object (e.g. `{ operatorTypeBatch: {} }`).
 */
export const operatorTypeVariant = (t: OperatorType): AnchorEnumVariant =>
  match(t)
    .with(OperatorType.UNKNOWN,     () => ({ operatorTypeUnknown:     {} }))
    .with(OperatorType.PRODUCER,    () => ({ operatorTypeProducer:    {} }))
    .with(OperatorType.BATCH,       () => ({ operatorTypeBatch:       {} }))
    .with(OperatorType.UNDERWRITER, () => ({ operatorTypeUnderwriter: {} }))
    .with(OperatorType.CHALLENGER,  () => ({ operatorTypeChallenger:  {} }))
    .otherwise(v => {
      throw new Error(`operatorTypeVariant: unknown OperatorType ${v}`)
    })

/**
 * Convert a numeric `TokenKind` to the Anchor IDL variant-tag object
 * expected by a wire-solana instruction's args.
 *
 * Post-v6 the `TokenKind` proto enum collapses to chain-agnostic token
 * STANDARDS — individual tokens (ETH, SOL, USDC, …) are no longer enum
 * members; they're `Token` rows keyed by slug_name. The Anchor IDL is
 * being migrated in lockstep by a separate agent; until that lands this
 * helper maps each present `TokenKind` to a stable variant-tag spelling.
 *
 * @param k Numeric token kind (e.g. `TokenKind.NATIVE`).
 * @return  Variant-tag object (e.g. `{ tokenKindNative: {} }`).
 */
export const tokenKindVariant = (k: TokenKind): AnchorEnumVariant =>
  match(k)
    .with(TokenKind.UNKNOWN, () => ({ tokenKindUnknown: {} }))
    .with(TokenKind.NATIVE,  () => ({ tokenKindNative:  {} }))
    .with(TokenKind.ERC20,   () => ({ tokenKindErc20:   {} }))
    .with(TokenKind.ERC721,  () => ({ tokenKindErc721:  {} }))
    .with(TokenKind.ERC1155, () => ({ tokenKindErc1155: {} }))
    .with(TokenKind.SPL,     () => ({ tokenKindSpl:     {} }))
    .with(TokenKind.SPL_NFT, () => ({ tokenKindSplNft:  {} }))
    .with(TokenKind.LIQ,     () => ({ tokenKindLiq:     {} }))
    .otherwise(v => {
      throw new Error(`tokenKindVariant: unknown TokenKind ${v}`)
    })

/**
 * `liqsol_core`'s launch state (`WireState` in
 * `wire-solana/programs/liqsol-core/src/states/wire_deposit_state.rs`). An
 * identity enum whose members ARE the Anchor variant-tag keys — the IDL
 * camelCases each Rust variant, which is exactly these spellings.
 */
export enum WireState {
  preLaunch = "preLaunch",
  launching = "launching",
  postLaunch = "postLaunch",
  refund = "refund"
}

/**
 * Convert a {@link WireState} to the Anchor IDL variant-tag object
 * `set_wire_state` expects.
 *
 * No `match` dispatch: the enum's members are identity-mapped to the IDL's
 * camelCased variant identifiers, so the member IS the tag key.
 *
 * @param state The launch state (e.g. `WireState.postLaunch`).
 * @return  Variant-tag object (e.g. `{ postLaunch: {} }`).
 */
export const wireStateVariant = (state: WireState): AnchorEnumVariant => ({
  [state]: {}
})

/**
 * The launch-state transitions `liqsol_core` accepts, mirroring
 * `WireState::can_transition_to`
 * (`wire-solana/programs/liqsol-core/src/states/wire_deposit_state.rs`).
 * `PostLaunch` is terminal; `Refund` is reachable from either pre-terminal
 * state.
 *
 * Mirrored here so a harness step can REFUSE an impossible transition with the
 * current state in the message, instead of submitting it and reading the
 * program's `InvalidWireState` revert back out of a cluster log.
 */
export const WireStateTransitions: Readonly<
  Record<WireState, ReadonlyArray<WireState>>
> = {
  [WireState.preLaunch]: [WireState.launching, WireState.refund],
  [WireState.launching]: [WireState.postLaunch, WireState.refund],
  [WireState.postLaunch]: [],
  [WireState.refund]: []
}

/**
 * Whether `liqsol_core` would accept moving from `current` to `next`.
 *
 * @param current The launch state on chain now.
 * @param next    The launch state being requested.
 * @return  `true` when the program's own `can_transition_to` would allow it.
 */
export const canTransitionWireState = (
  current: WireState,
  next: WireState
): boolean => WireStateTransitions[current].includes(next)
