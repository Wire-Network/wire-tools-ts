/** A deployed 20-byte EVM address — `0x` + 40 hex characters, any letter case (checksummed or not). */
export const EvmAddressPattern = /^0x[0-9a-fA-F]{40}$/

/** A Solana address — the base58 encoding of a 32-byte Ed25519 public key (32–44 characters). */
export const SolanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * A compressed 33-byte secp256k1 public key as hex — an optional `0x`, the `02`/`03` parity
 * prefix, then the 32-byte X coordinate. The key an EVM account authenticates with; its
 * 20-byte address cannot recover it.
 */
export const EvmCompressedPublicKeyPattern = /^(0x)?0[23][0-9a-fA-F]{64}$/
