import type { EthereumKeyPair, SolanaKeyPair } from "../../types/KeyPair.js"
import { outputKey } from "../OutputStore.js"

/** Unlinked outpost identity holding the imported positions; a flow later links its keys. */
export interface MockSyndicationBonderOutput {
  readonly solana: SolanaKeyPair
  readonly ethereum: EthereumKeyPair
}

/** Typed handle for the persisted mock bonder's outpost keys. */
export const MockSyndicationBonderKey = outputKey<MockSyndicationBonderOutput>(
  "mock-syndication-bonder",
  "unlinked ED/EM identity holding the bootstrap import"
)
