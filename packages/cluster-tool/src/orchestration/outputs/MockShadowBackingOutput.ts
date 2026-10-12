import { outputKey } from "../OutputStore.js"

/** Native liqSOL backing to acquire and donate; zero when custody already covers shadow. */
export const MockShadowBackingSolanaRequiredKey = outputKey<bigint>(
  "mockShadowBacking.solana",
  "native liqSOL backing"
)

/** Native liqETH backing to acquire and donate; zero when custody already covers shadow. */
export const MockShadowBackingEthereumRequiredKey = outputKey<bigint>(
  "mockShadowBacking.ethereum",
  "native liqETH backing"
)

/** Depot obligation captured before funding, also seeded as Ethereum principal. */
export const MockShadowBackingEthereumPrincipalKey = outputKey<bigint>(
  "mockShadowBacking.ethereumPrincipal",
  "Ethereum backing in depot units"
)
