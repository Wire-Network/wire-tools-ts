import Path from "node:path"
import {
  Constants as HarnessConstants,
  type ClusterBuildOptions,
  type WireLcoExportTool
} from "@wireio/cluster-tool"
import { ChainKind, LiqPoolSpec } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Constants for the launch-data import flow. The committed exports under `resources/` are
 * TEMPLATES: each row names a placeholder identity, which the scenario's pre-bootstrap stage
 * (`LcoImportScenarioExports`, through `WireLcoExportTool`) replaces with the random key it
 * generates and persists under the holder's durable handle — an Ethereum wallet, a Solana
 * keypair — before writing the exports the bootstrap imports. Each chain has one staker (a
 * syndicated position plus pretoken yield) and one purchaser (pretokens only).
 */
export namespace LcoImportScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor. */
  export const EpochDurationSec = 60

  /** The package's committed export templates. */
  export const ResourcesPath = Path.join(__dirname, "..", "resources")
  /** The frozen Ethereum outpost's export template (opp-snapshot shape, with the booked custody). */
  export const EthereumTemplateFile = Path.join(
    ResourcesPath,
    "ethereum-genesis-snapshot.json"
  )
  /** The Solana outpost's genesis export template. */
  export const SolanaTemplateFile = Path.join(
    ResourcesPath,
    "solana-genesis-snapshot.json"
  )
  /** Both templates, by chain — what the export tool rewrites. */
  export const Templates: WireLcoExportTool.ChainFiles = {
    ethereum: EthereumTemplateFile,
    solana: SolanaTemplateFile
  }

  /** ETH's launch price: USD with 8 decimals ($4,000). */
  export const EthereumPriceUsd = "400000000000"
  /** SOL's launch price: USD with 8 decimals ($200). */
  export const SolanaPriceUsd = "20000000000"
  /** Both pools' tuning: the dev bootstrap config's. */
  export const PoolTuning = LiqPoolSpec.create({
    fee: 30,
    conversionHorizonSec: 86_400,
    depthCapBps: 30,
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

  /** What every fixture holder carries: a WIRE account and the placeholder its template rows name. */
  export interface HolderBase {
    /** The WIRE account the holder links its key to. */
    readonly account: string
    /**
     * The placeholder address the template's rows carry for this holder, in the export's
     * display form (the EVM address, or the base58 key). Every row naming it is rewritten
     * to the holder's persisted key.
     */
    readonly templateAddress: string
  }

  /** An Ethereum holder: its key is the random wallet persisted under `walletName`. */
  export interface EthereumHolder extends HolderBase {
    readonly chain: ChainKind.EVM
    /** Durable handle of its persisted Ethereum wallet. */
    readonly walletName: string
  }

  /** A Solana holder: its key is the random keypair persisted under `keypairName`. */
  export interface SolanaHolder extends HolderBase {
    readonly chain: ChainKind.SVM
    /** Durable handle of its persisted Solana keypair. */
    readonly keypairName: string
  }

  /** One fixture holder, on either chain. */
  export type Holder = EthereumHolder | SolanaHolder

  /** Staked 2 ETH and bought pretokens too. */
  export const EthereumStaker: EthereumHolder = {
    account: "lcoethstaker",
    chain: ChainKind.EVM,
    walletName: "lco-ethereum-staker",
    templateAddress: "0x145e2dc5c8238d1be628f87076a37d4a26a78544"
  }
  /** Bought pretokens with 1 ETH of liqETH. */
  export const EthereumPurchaser: EthereumHolder = {
    account: "lcoethbuyer1",
    chain: ChainKind.EVM,
    walletName: "lco-ethereum-purchaser",
    templateAddress: "0xd6a098ebcc5f8bd4e174d915c54486b077a34a51"
  }
  /** Syndicated 4 liqSOL and earned pretoken yield. */
  export const SolanaStaker: SolanaHolder = {
    account: "lcosolstaker",
    chain: ChainKind.SVM,
    keypairName: "lco-solana-staker",
    templateAddress: "23znL2rifcBadqzoV2aPc9jWHVv4ucnJD7tUF5LTV58r"
  }
  /** Bought pretokens with 2 liqSOL. */
  export const SolanaPurchaser: SolanaHolder = {
    account: "lcosolbuyer1",
    chain: ChainKind.SVM,
    keypairName: "lco-solana-purchaser",
    templateAddress: "H1fWPFrj7fcNNHrSysapKwCttyiiaWFXCHkPbrDpMHXG"
  }
  /** The Ethereum holders. */
  export const EthereumHolders: EthereumHolder[] = [
    EthereumStaker,
    EthereumPurchaser
  ]
  /** The Solana holders. */
  export const SolanaHolders: SolanaHolder[] = [SolanaStaker, SolanaPurchaser]
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
