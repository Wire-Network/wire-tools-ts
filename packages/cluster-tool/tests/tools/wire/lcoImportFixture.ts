import { createHash } from "node:crypto"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type {
  EthereumGenesisSnapshot,
  LcoImportChainConfig,
  LcoImportConfig,
  SolanaGenesisSnapshot
} from "@wireio/cluster-tool-shared"

/** Wei per liqETH / pretoken (18 decimals). */
export const WeiPerEther = 10n ** 18n

/** The compressed secp256k1 generator point — a valid even-parity key. */
export const GeneratorPublicKey =
  "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
/** A second valid compressed key: −2·G, odd parity. */
export const DoubleGeneratorPublicKey =
  "0x03c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"

/** The first staker's address — {@link GeneratorPublicKey}'s; it also bought pretokens. */
export const StakerAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
/** The second staker's address — {@link DoubleGeneratorPublicKey}'s. */
export const SecondStakerAddress = "0x92d48ff5523c9b04aa426191b4bd21e6080f074a"
/** A purchaser that never staked. */
export const PurchaserAddress = "0x2222222222222222222222222222222222222222"
/** An address that unstaked everything and has no recovered key. */
export const UnstakedAddress = "0x4444444444444444444444444444444444444444"

/**
 * An opp-snapshot export: 3 + 1.5 ETH (plus 7 wei of dust) staked, 2 ETH spent on pretokens,
 * a fully unstaked keyless address, and a staker who also bought pretokens.
 */
export function ethereumSnapshot(): EthereumGenesisSnapshot {
  return {
    stakers: [
      {
        address: StakerAddress,
        pubkey: GeneratorPublicKey,
        totalShares: (3n * WeiPerEther).toString(),
        totalPrincipalIn: (3n * WeiPerEther).toString(),
        totalAmountOut: "0",
        netPrincipal: (3n * WeiPerEther).toString(),
        yieldClaimed: "0",
        pretokenYield: (WeiPerEther / 4n).toString()
      },
      {
        address: SecondStakerAddress,
        pubkey: DoubleGeneratorPublicKey.toUpperCase().replace("0X", "0x"),
        totalShares: ((3n * WeiPerEther) / 2n + 7n).toString(),
        totalPrincipalIn: ((3n * WeiPerEther) / 2n + 7n).toString(),
        totalAmountOut: "0",
        netPrincipal: ((3n * WeiPerEther) / 2n + 7n).toString(),
        yieldClaimed: "0",
        pretokenYield: "0"
      },
      {
        address: UnstakedAddress,
        pubkey: null,
        totalShares: "0",
        totalPrincipalIn: "0",
        totalAmountOut: "0",
        netPrincipal: "0",
        yieldClaimed: "0",
        pretokenYield: "0"
      }
    ],
    purchasers: [
      {
        address: PurchaserAddress,
        pretokens: (3n * WeiPerEther).toString(),
        liqShares: (2n * WeiPerEther).toString(),
        liqPrincipalIn: (2n * WeiPerEther).toString(),
        yieldClaimed: "0",
        pretokenYield: "0",
        totalPretokens: (3n * WeiPerEther).toString()
      },
      {
        address: StakerAddress,
        pretokens: WeiPerEther.toString(),
        liqShares: "0",
        liqPrincipalIn: "0",
        yieldClaimed: "0",
        pretokenYield: "0",
        totalPretokens: WeiPerEther.toString()
      }
    ],
    metadata: {
      lastMessageId: "0xabc",
      lastTimestamp: "1760000000",
      latestIndex: "1000000000000000000000000000",
      totalMessages: 12,
      totalPrincipal: ((9n * WeiPerEther) / 2n + 7n).toString(),
      yieldDust: "0",
      totalLiqEthStaked: ((9n * WeiPerEther) / 2n + 7n).toString(),
      totalLiqEthPurchased: (2n * WeiPerEther).toString(),
      generatedAt: "2026-10-21T00:00:00.000Z"
    }
  }
}

/**
 * `snapshot` with the metadata totals opp-snapshot derives from its rows: the stakers' net
 * principal and the purchasers' liqETH principal.
 */
export function withEthereumTotals(
  snapshot: EthereumGenesisSnapshot
): EthereumGenesisSnapshot {
  const sum = (amounts: string[]) =>
      amounts.reduce((total, amount) => total + BigInt(amount), 0n).toString(),
    staked = sum(snapshot.stakers.map(staker => staker.netPrincipal))
  snapshot.metadata.totalPrincipal = staked
  snapshot.metadata.totalLiqEthStaked = staked
  snapshot.metadata.totalLiqEthPurchased = sum(
    snapshot.purchasers.map(purchaser => purchaser.liqPrincipalIn)
  )
  return snapshot
}

/** A wallet that syndicated 5 liqSOL and earned 1.2 pretokens. */
export const SolanaStakerAddress = "So11111111111111111111111111111111111111112"
/** A wallet that only bought 3 pretokens. */
export const SolanaPurchaserAddress = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

/**
 * A genesis export: 5 liqSOL syndicated and 1 spent on pretokens, so the pool gets exactly that
 * 1. The 8 liqSOL backing also holds 2 of slack, which is not minted.
 */
export function solanaSnapshot(): SolanaGenesisSnapshot {
  return withAllocationHash({
    schemaVersion: 1,
    programId: "5nBtmutzLgNKe8NxgTWE3uhPMm8u8T3ggTq2ApZRnbbq",
    allocationHash: "",
    balances: [
      {
        address: SolanaStakerAddress,
        outpostAccount: null,
        pretokenRecord: null,
        syndicatedLiqsol: "5000000000",
        purchasedLiqsol: "0",
        stakedShares: "5000000000",
        purchasedShares: "0",
        directlyPurchasedPretokens: "0",
        pretokenYield: "120000000",
        totalPretokens: "120000000"
      },
      {
        address: SolanaPurchaserAddress,
        outpostAccount: null,
        pretokenRecord: null,
        syndicatedLiqsol: "0",
        purchasedLiqsol: "1000000000",
        stakedShares: "0",
        purchasedShares: "1000000000",
        directlyPurchasedPretokens: "300000000",
        pretokenYield: "0",
        totalPretokens: "300000000"
      }
    ],
    accounting: {
      wireState: "Launching",
      mode: "genesis",
      epoch: "7",
      historyAddress: "6mQH7tCvb6b7gWmY1HxcbyX3c8QGQh2dXvQnZt1kDhHV",
      attributionThroughEpoch: "6",
      poolAuthority: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
      poolTokenAccount: "3pNvWmDmM9QvJ9Y3zHzN7bKrj9Q3q6vFrAhZB8NnjWeR",
      poolBalance: "9000000000",
      poolPretokens: "120000000",
      allocatedPretokenYield: "120000000",
      unallocatedPoolPretokens: "0",
      directlyPurchasedPretokens: "300000000",
      totalUserPretokens: "420000000",
      totalPretokensSold: "420000000",
      ownerlessShares: "0",
      unreportedLiqsolYield: "1000000000",
      backingAvailable: "8000000000",
      initialChainAmount: "1000000000",
      issues: [],
      warnings: [],
      units: {
        liqsolDecimals: 9,
        pretokenDecimals: 8,
        indexScale: "1000000000000"
      }
    }
  })
}

/**
 * `snapshot` with the `allocationHash` capital-index declares for it: SHA-256 over the
 * compact JSON of its `schemaVersion`, `programId` and `balances`.
 */
export function withAllocationHash(
  snapshot: SolanaGenesisSnapshot
): SolanaGenesisSnapshot {
  const { schemaVersion, programId, balances } = snapshot
  snapshot.allocationHash = createHash("sha256")
    .update(JSON.stringify({ schemaVersion, programId, balances }))
    .digest("hex")
  return snapshot
}

/** A temp directory exports are written into, removed by {@link LcoImportFixture.remove}. */
export class LcoImportFixture {
  readonly path = Fs.mkdtempSync(Path.join(Os.tmpdir(), "lco-import-"))

  /** Write `document` as `name` and return its path. */
  write(name: string, document: unknown): string {
    const file = Path.join(this.path, name)
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  /** A chain config naming the written `document`, every pricing member unset. */
  chain(name: string, document: unknown): LcoImportChainConfig {
    return {
      bootstrapJsonFile: this.write(name, document),
      nativePriceUsd: null,
      highestTranchePriceUsd: null,
      pool: null
    }
  }

  /** An import of both fixture exports, nothing priced. */
  config(): LcoImportConfig {
    return {
      ethereum: this.chain("ethereum.json", ethereumSnapshot()),
      solana: this.chain("solana.json", solanaSnapshot()),
      dclaimFundingAccount: null
    }
  }

  /** Remove the directory. */
  remove(): void {
    Fs.rmSync(this.path, { recursive: true, force: true })
  }
}
