import Assert from "node:assert"

/**
 * The ABI-mirror enum member for a proto enum VALUE.
 *
 * The generated `Sysio<Contract><Enum>` ABI enums mirror the OPP proto enums
 * value-for-value, but their SPELLINGS differ (protobuf-ts strips the shared
 * `CHAIN_KIND_`-style prefix from TS member names; the ABI keeps the full wire
 * spelling) and TypeScript's nominal enum typing rejects a direct cross-enum
 * assignment. The numeric VALUE is the invariant, so this checked bridge
 * resolves through the ABI enum's own numeric reverse mapping — an undeclared
 * value fails loudly at the call instead of pushing a wrong numeric on-chain.
 *
 * @param abiEnum - The generated ABI-mirror enum object (e.g. `SysioAuthexChainkind`).
 * @param value - The proto enum member's numeric value.
 * @returns The matching ABI enum member.
 * @example
 *   chain_kind: abiEnumValue(SysioContracts.SysioAuthexChainkind, chainKind)
 */
export function abiEnumValue<Abi extends Record<string, string | number>>(
  abiEnum: Abi,
  value: number
): Abi[keyof Abi] {
  const spelling = abiEnum[value]
  Assert.ok(
    typeof spelling === "string",
    `no ABI enum member is declared for proto value ${value}`
  )
  return abiEnum[spelling as keyof Abi]
}
