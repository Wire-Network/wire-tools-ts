import Assert from "node:assert"
import {
  ClusterBuildContext,
  ClusterBuildStep,
  EthereumCollateralTool,
  loadMockWireNodes,
  mintNodeNFT,
  NodeOwnerTier,
  outputKey,
  Report,
  type ClusterBuildStepOptions,
  type MockWireNodesContract,
  type StepInput
} from "@wireio/test-cluster-tool"

/**
 * Step factory + companions for the `MockWireNodes.sol` ERC-1155 mint — the
 * outpost surface the production flow observes (its `TransferSingle`) to build
 * the NodeOwnerRegistration attestation. The {@link planMint} write is its OWN
 * {@link ClusterBuildStep}; the pre-mint `viewTotalSupply` snapshot rides
 * `ctx.outputs` under {@link TotalSupplyBeforeKey} so the scenario's supply
 * verify reads it back without shared mutable closures.
 */
export namespace NodeOwnerNftScenarioMintSteps {
  /** `viewTotalSupply` snapshot taken before the planMint (consumed by the supply verify). */
  export const TotalSupplyBeforeKey = outputKey<bigint>(
    "NodeOwnerNftScenarioMintSteps.totalSupplyBefore",
    "MockWireNodes totalSupply for the minted tier, snapshotted before the mint"
  )

  /**
   * Resolve `MockWireNodes` from the run's deploy artifacts
   * (`outpost-addrs.json` + the hardhat artifact), bound to the run's default
   * anvil signer — the minter. A pure artifact load: used inside the
   * {@link planMint} runner and the scenario's snapshot / supply verify steps.
   *
   * @param ctx - The build context (ethereum path + anvil client).
   * @returns The signer-bound contract surface.
   */
  export function resolveMockWireNodes<C extends ClusterBuildContext>(
    ctx: C
  ): MockWireNodesContract {
    return loadMockWireNodes(
      ctx.config.ethereumPath,
      EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath),
      ctx.ethereum.wallet.signer
    )
  }

  /** Input for {@link planMint} — one MockWireNodes ERC-1155 mint write. */
  export interface MintInput extends StepInput {
    readonly kind: "NodeOwnerNftScenarioMintSteps.MintInput"
    /** The ERC-1155 id minted (the node-owner tier). */
    readonly tier: NodeOwnerTier
    /** Units minted; the contract charges `1 ether * amount`. */
    readonly amount: number
  }

  /**
   * A single `MockWireNodes.mint(tier, amount)` write (value =
   * `1 ether * amount`, supplied by the helper).
   *
   * @param actor - The narrative subject (the minting user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param tier - The ERC-1155 id to mint.
   * @param amount - Units to mint.
   * @returns The definition step.
   */
  export function planMint<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    tier: NodeOwnerTier,
    amount: number
  ): ClusterBuildStep<C, MintInput> {
    return ClusterBuildStep.create<C, MintInput>(
      actor,
      name,
      description,
      options,
      { kind: "NodeOwnerNftScenarioMintSteps.MintInput", tier, amount },
      runMint
    )
  }

  /** Named runner — ONE MockWireNodes mint; asserts the receipt landed (status 1). */
  export async function runMint<C extends ClusterBuildContext>(
    ctx: C,
    input: MintInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const receipt = await mintNodeNFT(resolveMockWireNodes(ctx), input.tier, input.amount)
    Assert.strictEqual(receipt.status, 1, "MockWireNodes.mint: receipt status must be 1")
  }
}
