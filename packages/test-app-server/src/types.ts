/**
 * Local ChainKind enum for this browser app.
 * Canonical source: `@wireio/opp-typescript-models` (proto-generated `ChainKind`).
 * Kept local to avoid pulling the full OPP models dependency into a lightweight browser bundle.
 */
export enum ChainKind {
  Unknown = 0,
  Wire = 1,
  Ethereum = 2,
  Solana = 3,
  Sui = 4
}

export interface AuthLink {
  key: number
  username: string
  chain_kind: ChainKind
  pub_key: string
  address: string
}

export interface WireChain {
  id: string
  name: string
  endpoint: string
  namespace: string
  coreSymbol: string
  contractAccount: string
}

export interface ConnectedAccount {
  address: string
  shortAddress: string
}
