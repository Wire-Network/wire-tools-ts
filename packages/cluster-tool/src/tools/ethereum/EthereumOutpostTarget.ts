import Assert from "node:assert"

import { ethers } from "ethers"
import { isObject, isString } from "lodash"
import type { ExternalOutpostConfigEthereum } from "@wireio/cluster-tool-shared"

import type { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"

/**
 * The MINIMUM real data an Ethereum outpost read or write needs — what the
 * syndication tool used to pull off a `ClusterBuildContext` (its provider, the
 * `ethereumPath` artifact tree and this cluster's deploy address records),
 * made a domain type so a CLUSTER-LESS surface (`fund-batch-operators`)
 * composes one from an `ExternalOutpostConfig` and the wire-ethereum repo
 * root.
 *
 * Unlike {@link SolanaOutpostTarget}, nothing derives one from a context
 * eagerly: a context's address RECORDS are files a runner reads per call
 * (`EthereumSyndicationTool.readDeployAddresses`), and its provider is a lazy
 * client that throws for an external-outpost cluster — so the tool resolves
 * each member from a context at the point of use instead.
 */
export interface EthereumOutpostTarget {
  /** The provider every read and submission goes through. */
  readonly provider: ethers.Provider
  /** The `wire-ethereum` repo root — the hardhat artifact tree the ABIs come from. */
  readonly ethereumPath: string
  /** The outpost chain's id, checked against the provider's network before any write. */
  readonly chainId: number
  /** The outpost deploy's address book (`outpost-addrs.json` content). */
  readonly outpostAddresses: ExternalOutpostConfigEthereum["outpostAddresses"]
  /** The liqEth deploy's address book (`liqeth-addrs.json` content); absent when the outpost has no liqETH. */
  readonly liqEthAddresses?: ExternalOutpostConfigEthereum["liqEthAddresses"]
  /**
   * The finalized block the describing document was generated at — the block
   * a post-launch `fund-batch-operators` counts this campaign's syndications
   * from; absent when the document carries none (a pre-launch funding needs
   * none).
   */
  readonly asOfBlock?: ExternalOutpostConfigEthereum["asOfBlock"]
}

/**
 * What an Ethereum outpost read or load may be addressed with: a build
 * context or the target itself — one parameter type, so every read keeps its
 * one name across both callers. The exported reads declare the two kinds as
 * OVERLOADS (target first, context last) over this implementation type, so
 * `Parameters<typeof read>[0]` keeps projecting the CONTEXT type the existing
 * runner tests build their fixtures from.
 */
export type EthereumOutpostSource<
  C extends ClusterBuildContext = ClusterBuildContext
> = C | EthereumOutpostTarget

export namespace EthereumOutpostTarget {
  /**
   * Whether `value` is an {@link EthereumOutpostTarget} rather than a build
   * context — structural: a context carries `ethereum` + `config`, never these
   * members at its top level.
   *
   * @param value - An {@link EthereumOutpostSource}.
   * @returns `true` for a target.
   */
  export function is(value: unknown): value is EthereumOutpostTarget {
    return (
      isObject(value) &&
      "provider" in value &&
      "ethereumPath" in value &&
      "outpostAddresses" in value
    )
  }

  /**
   * The target an already-deployed outpost's trusted config describes.
   *
   * @param ethereum - The config's Ethereum outpost (chain id, address books, RPC endpoint, as-of block).
   * @param ethereumPath - The `wire-ethereum` repo root (artifact tree).
   * @param provider - The provider to the outpost ({@link createProvider}).
   * @returns The target.
   */
  export function fromExternalOutpost(
    ethereum: ExternalOutpostConfigEthereum,
    ethereumPath: string,
    provider: ethers.Provider
  ): EthereumOutpostTarget {
    return {
      provider,
      ethereumPath,
      chainId: ethereum.chainId,
      outpostAddresses: ethereum.outpostAddresses,
      ...(ethereum.liqEthAddresses != null
        ? { liqEthAddresses: ethereum.liqEthAddresses }
        : {}),
      ...(ethereum.asOfBlock != null ? { asOfBlock: ethereum.asOfBlock } : {})
    }
  }

  /**
   * The RPC endpoint an external outpost config MUST carry for a cluster-less
   * command to reach the outpost (a `create` may leave it to the bind config;
   * a command with no cluster has no bind config to fall back to).
   *
   * @param ethereum - The config's Ethereum outpost.
   * @returns The endpoint.
   * @throws If the config carries none.
   */
  export function assertRpcUrl(ethereum: ExternalOutpostConfigEthereum): string {
    Assert.ok(
      isString(ethereum.rpcUrl) && ethereum.rpcUrl.length > 0,
      "EthereumOutpostTarget: the external outpost config must carry ethereum.rpcUrl — a cluster-less command has no bind config to fall back to"
    )
    return ethereum.rpcUrl
  }

  /**
   * A plain JSON-RPC provider to an outpost — what a cluster-less command dials
   * with (no Step, so no recording provider).
   *
   * @param rpcUrl - The outpost RPC endpoint.
   * @returns The provider.
   */
  export function createProvider(rpcUrl: string): ethers.JsonRpcProvider {
    return new ethers.JsonRpcProvider(rpcUrl)
  }

  /**
   * Assert the provider really fronts the chain the target names — the ONE
   * check that stops a pre-funding run from staking real value on the wrong
   * network because a config's `rpcUrl` and `chainId` disagree.
   *
   * @param target - The target.
   * @throws If the provider's network id differs from `target.chainId`.
   */
  export async function assertChainId(
    target: EthereumOutpostTarget
  ): Promise<void> {
    const { chainId } = await target.provider.getNetwork()
    Assert.strictEqual(
      Number(chainId),
      target.chainId,
      `EthereumOutpostTarget: the RPC endpoint fronts chain ${chainId}, not the configured ${target.chainId}`
    )
  }
}
