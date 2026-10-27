import Path from "node:path"
import {
  AnvilProcess,
  Constants as HarnessConstants,
  EthereumOutpostBootstrapper,
  EthereumSyndicationTool,
  SolanaFundingTool,
  WireLcoImportTool,
  type ClusterBuildOptions,
  type ImportSeedChainKind
} from "@wireio/cluster-tool"
import { ChainKind, LiqPoolSpec } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Constants for the launch-data import flow. The committed exports under `resources/` name
 * the flow's own holders, whose keys derive here: two Ethereum holders from anvil HD
 * wallets, two Solana holders from seeded keypairs. Each chain has one staker (a
 * syndicated position plus pretoken yield) and one purchaser (pretokens only).
 */
export namespace LcoImportScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor. */
  export const EpochDurationSec = 60

  /** The package's committed exports. */
  export const ResourcesPath = Path.join(__dirname, "..", "resources")
  /** The frozen Ethereum outpost's export (opp-snapshot shape, with the booked custody). */
  export const EthereumExportFile = Path.join(
    ResourcesPath,
    "ethereum-genesis-snapshot.json"
  )
  /** The Solana outpost's genesis export. */
  export const SolanaExportFile = Path.join(
    ResourcesPath,
    "solana-genesis-snapshot.json"
  )

  /** ETH's launch price: USD with 8 decimals ($4,000). */
  export const EthereumPriceUsd = "400000000000"
  /** SOL's launch price: USD with 8 decimals ($200). */
  export const SolanaPriceUsd = "20000000000"
  /** Both pools' tuning: the dev bootstrap config's. */
  export const PoolTuning = LiqPoolSpec.create({
    fee: 30,
    conversionHorizonSec: 86_400,
    depthCapBps: 50,
    clipFloor: 1_000n
  })
  /**
   * The import's pricing (the highest tranche price rides each export), pool tuning and
   * claim funding — every value set, so the import takes no placeholder.
   */
  export const LcoImport: ClusterBuildOptions["lcoImport"] = {
    ethereum: { nativePriceUsd: EthereumPriceUsd, pool: PoolTuning },
    solana: { nativePriceUsd: SolanaPriceUsd, pool: PoolTuning },
    dclaimFundingAccount: SysioContractAccount[SysioContractName.system]
  }

  /** One fixture holder: a WIRE account and the outpost identity the export names. */
  export interface Holder {
    /** The WIRE account the holder links its key to. */
    readonly account: string
    /** The holder's chain. */
    readonly chain: ImportSeedChainKind
    /** Its public key in display form: compressed secp256k1 `0x` hex, or base58 Ed25519. */
    readonly pubkey: string
    /** Its native address in display form: the EVM address, or the base58 key. */
    readonly address: string
  }

  /** An Ethereum holder: its key is the anvil HD wallet at `ethereumHdIndex`. */
  export interface EthereumHolder extends Holder {
    readonly ethereumHdIndex: number
  }

  /** A Solana holder: its key derives from `seed` and persists under `keypairName`. */
  export interface SolanaHolder extends Holder {
    readonly keypairName: string
    readonly seed: string
  }

  /** The Ethereum holder at `ethereumHdIndex`. */
  function ethereumHolder(
    account: string,
    ethereumHdIndex: number
  ): EthereumHolder {
    return {
      account,
      chain: ChainKind.EVM,
      pubkey: EthereumSyndicationTool.compressedPubkey(ethereumHdIndex),
      address: WireLcoImportTool.evmDisplayHex(
        EthereumOutpostBootstrapper.anvilWallet(ethereumHdIndex).address
      ),
      ethereumHdIndex
    }
  }

  /** The Solana holder `seed` derives. */
  function solanaHolder(
    account: string,
    keypairName: string,
    seed: string
  ): SolanaHolder {
    const key = SolanaFundingTool.seededKeypair(seed).publicKey.toBase58()
    return {
      account,
      chain: ChainKind.SVM,
      pubkey: key,
      address: key,
      keypairName,
      seed
    }
  }

  /**
   * HD indices past every funded anvil account and the mock bonder's: the holders only sign
   * their links, so they need no ETH.
   */
  export const EthereumStakerHdIndex = AnvilProcess.AccountCount + 1
  /** See {@link EthereumStakerHdIndex}. */
  export const EthereumPurchaserHdIndex = AnvilProcess.AccountCount + 2

  /** Staked 2 ETH and bought pretokens too. */
  export const EthereumStaker = ethereumHolder(
    "lcoethstaker",
    EthereumStakerHdIndex
  )
  /** Bought pretokens with 1 ETH of liqETH. */
  export const EthereumPurchaser = ethereumHolder(
    "lcoethbuyer1",
    EthereumPurchaserHdIndex
  )
  /** Syndicated 4 liqSOL and earned pretoken yield. */
  export const SolanaStaker = solanaHolder(
    "lcosolstaker",
    "lco-solana-staker",
    "flow-lco-import:solana-staker"
  )
  /** Bought pretokens with 2 liqSOL. */
  export const SolanaPurchaser = solanaHolder(
    "lcosolbuyer1",
    "lco-solana-purchaser",
    "flow-lco-import:solana-purchaser"
  )
  /** The Ethereum holders. */
  export const EthereumHolders = [EthereumStaker, EthereumPurchaser]
  /** The Solana holders. */
  export const SolanaHolders = [SolanaStaker, SolanaPurchaser]
  /** Every holder. */
  export const Holders: Holder[] = [...EthereumHolders, ...SolanaHolders]
  /** The holders the exports give a syndicated position. */
  export const Stakers: Holder[] = [EthereumStaker, SolanaStaker]

  /** The LIQSOL pool's pair code — what the trade's exchange memo names. */
  export const TradePairCode = HarnessConstants.liqPoolPairCode(
    HarnessConstants.LIQSOL_CODENAME
  )
  /** WIRE the Solana staker sells into the LIQSOL pool after claiming: one WIRE. */
  export const TradeWireAmount = 1_000_000_000n
  /** The least LIQSOL the trade accepts, in subunits. */
  export const TradeMinimumOut = 1
  /** `sysio.swap::ontransfer`'s prefix for a transfer that exchanges rather than deposits. */
  export const ExchangeMemoPrefix = "exchange:"
  /** The memo the swap forwards with the bought LIQSOL. */
  export const TradeMemo = "lco-import pool trade"
}
