/** Lexical patterns of the engine's response values. */
export namespace QueryResultPatterns {
  /** An unsigned decimal counter (`definitions.unsignedDecimal` of the response schema). */
  export const UnsignedDecimal = /^(0|[1-9][0-9]*)$/
  /** A signed integer cell (`integer` logical type: no fraction). */
  export const SignedInteger = /^-?(0|[1-9][0-9]*)$/
  /** A signed decimal number cell (integers and exact decimal fractions). */
  export const SignedDecimal = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/
  /** An `ieee_hex` cell: `0x` plus the raw little-endian IEEE bytes. */
  export const IeeeHex = /^0x([0-9a-f]{2})+$/i
}
