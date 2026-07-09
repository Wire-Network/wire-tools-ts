import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { FlowTestContext } from "@wireio/test-cluster-tool"
import { ethers } from "ethers"

import type { SwapUserIdentities, WireUser } from "@wireio/test-cluster-tool"

/** Fully bootstrapped real stress flow context. */
export type RealStressFlow = {
  readonly context: FlowTestContext
  readonly users: SwapUserIdentities
  readonly owner: WireUser
  readonly reserveManager: ethers.Contract
  readonly oppProgram: anchor.Program<anchor.Idl>
  readonly solanaConnection: Connection
  readonly usdcSolMint: PublicKey
  readonly solDeployer: Keypair
}

/** Persisted SPL mock mint record written by SOL bootstrap. */
export type SplMintRecord = {
  readonly code: number
  readonly mint: string
  readonly decimals: number
}

/** Depot reserve table row fields used by the real stress flow. */
export type ReserveRow = {
  readonly chain_code: unknown
  readonly token_code: unknown
  readonly reserve_code: unknown
  readonly status: unknown
  readonly reserve_chain_amount: string | number
  readonly reserve_wire_amount: string | number
}

/** Narrow Anchor account fetcher surface for Reserve PDA status reads. */
export type AnchorAccountFetcher = {
  readonly fetch: (address: PublicKey) => Promise<{ readonly status: unknown }>
}
