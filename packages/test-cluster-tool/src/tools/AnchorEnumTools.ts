/**
 * Anchor IDL enum-variant tag helpers.
 *
 * The `@coral-xyz/anchor` TS client encodes Rust enum arguments as
 * single-key tagged-union objects whose key is the camelCased variant
 * identifier and whose value is `{}`. Passing a raw numeric enum value
 * makes the Borsh union encoder throw `Union.defaultGetSourceVariant`.
 *
 * Centralized here so every TS-side Anchor IX call against
 * `wire-solana` programs (opp-outpost today; liqsol-* in future) reuses
 * the same mapping rather than re-deriving it ad-hoc.
 */

import { match } from "ts-pattern"
import { OperatorType, TokenKind } from "@wireio/opp-typescript-models"

/** Anchor variant-tag object — single key, empty payload. */
export type AnchorEnumVariant = Readonly<Record<string, Record<string, never>>>

/**
 * Convert a numeric `OperatorType` to the Anchor IDL variant-tag object
 * expected by `opp-outpost` instruction args.
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
 * expected by `opp-outpost` instruction args.
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
