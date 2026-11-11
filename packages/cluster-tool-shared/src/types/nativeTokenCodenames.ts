/**
 * The depot codenames of the outposts' NATIVE assets — the `sysio.tokens`
 * codes the registry registers as `TOKEN_KIND_NATIVE`, and the token codes a
 * batch operator's native stake / gas reserve (`BatchOperatorUnderwritingConfig`)
 * is denominated in. Declared in the shared package because the persisted
 * config schema's defaults reference them; the harness's `Constants` aliases
 * them rather than re-spelling them.
 */

/** The depot codename of the Ethereum outpost's native asset (`sysio.tokens` code `ETH`). */
export const EthereumNativeTokenCodename = "ETH"
/** The depot codename of the Solana outpost's native asset (`sysio.tokens` code `SOL`). */
export const SolanaNativeTokenCodename = "SOL"

/** Every outpost native codename, in outpost order (Ethereum, then Solana). */
export const NativeTokenCodenames = [
  EthereumNativeTokenCodename,
  SolanaNativeTokenCodename
] as const

/** One outpost native codename — derived from {@link NativeTokenCodenames}, never re-spelled. */
export type NativeTokenCodename = (typeof NativeTokenCodenames)[number]

/**
 * The depot precision every native outpost token is registered at
 * (`sysio.tokens::regtoken` precision 9) — the frame a native `TokenAmount`'s
 * `amount` is in. A chain-native amount is `amount × 10^(nativeDecimals − 9)`:
 * wei for Ethereum (18 decimals), lamports for Solana (9 decimals, so 1:1).
 * Changing it changes how every native stake / reserve amount is read.
 */
export const NativeTokenDepotPrecision = 9
