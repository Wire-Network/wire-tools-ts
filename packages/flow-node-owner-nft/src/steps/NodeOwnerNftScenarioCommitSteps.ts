import Assert from "node:assert"
import {
  ClusterBuildContext,
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  NodeOwnerTier,
  Report,
  approveNodeEscrow,
  commitNode,
  loadBar,
  wireKeyFromPublicKey,
  type BarContract,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { NodeOwnerNftScenarioMintSteps as MintSteps } from "./NodeOwnerNftScenarioMintSteps.js"

/**
 * Step factory + companions for the PRODUCTION node-owner claim path —
 * `BAR.commitNode` on the Ethereum outpost. The {@link planCommitNode} write
 * queues the full `NodeOwnerRegistration` NODE_OWNER_REG attestation, which
 * rides the next outbound OPP envelope to the depot, where
 * `sysio.msgch::dispatch_node_owner_reg` inline-sends the same
 * `newnameduser` + `nodeownreg` pair the scenario's direct-drive phases push
 * by hand. The committer is the run's default anvil wallet: it holds the
 * minted tier token, and its uncompressed secp256k1 key is the claim's
 * depositor key (recorded as the account's `sysio.authex` ETH link).
 *
 * The commit ESCROWS the committed unit in BAR (claims draw from BAR's
 * canonical WireNodes contract, wired by deployLocal), so the committer
 * must first approve BAR as an ERC-1155 operator — the
 * {@link planApproveEscrow} write, one step before the commit.
 */
export namespace NodeOwnerNftScenarioCommitSteps {
  /**
   * Resolve `BAR` from the run's deploy artifacts (`outpost-addrs.json` + the
   * hardhat artifact), bound to the run's default anvil signer — the
   * committer. A pure artifact load: used inside the {@link planCommitNode}
   * runner.
   *
   * @param ctx - The build context (ethereum path + anvil client).
   * @returns The signer-bound contract surface.
   */
  export function resolveBar<C extends ClusterBuildContext>(ctx: C): BarContract {
    return loadBar(
      ctx.config.ethereumPath,
      EthereumCollateralTool.loadOutpostAddresses(
        ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
      ),
      ctx.ethereum.wallet.signer
    )
  }

  /** Input for {@link planApproveEscrow} — one `setApprovalForAll` write. */
  export interface ApproveEscrowInput extends StepInput {
    readonly kind: "NodeOwnerNftScenarioCommitSteps.ApproveEscrowInput"
  }

  /**
   * A single `MockWireNodes.setApprovalForAll(BAR, true)` write — the
   * one-time ERC-1155 operator approval `commitNode`'s escrow pull needs.
   * Idempotent; plan it once before the first {@link planCommitNode}.
   *
   * @param actor - The narrative subject (the committing user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @returns The definition step.
   */
  export function planApproveEscrow<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ApproveEscrowInput> {
    return ClusterBuildStep.create<C, ApproveEscrowInput>(
      actor,
      name,
      description,
      options,
      { kind: "NodeOwnerNftScenarioCommitSteps.ApproveEscrowInput" },
      runApproveEscrow
    )
  }

  /**
   * Named runner — ONE `setApprovalForAll` write approving BAR on
   * MockWireNodes, both resolved from the run's deploy artifacts and bound
   * to the committer wallet.
   */
  export async function runApproveEscrow<C extends ClusterBuildContext>(
    ctx: C,
    _input: ApproveEscrowInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const receipt = await approveNodeEscrow(
      MintSteps.resolveMockWireNodes(ctx),
      await resolveBar(ctx).getAddress()
    )
    Assert.strictEqual(
      receipt.status,
      1,
      "MockWireNodes.setApprovalForAll: receipt status must be 1"
    )
  }

  /** Input for {@link planCommitNode} — one `BAR.commitNode` write. */
  export interface CommitNodeInput extends StepInput {
    readonly kind: "NodeOwnerNftScenarioCommitSteps.CommitNodeInput"
    /** The claimed tier — WireNodes token ids ARE the tiers, so also the ERC-1155 id committed. */
    readonly tier: NodeOwnerTier
    /** The Wire account the claim registers (created in-flow by the depot when absent). */
    readonly wireAccountName: string
    /** The account's claimed owner/active Wire key (`PUB_*` string form, for the Report). */
    readonly wirePublicKey: string
  }

  /**
   * A single `BAR.commitNode` write — the production claim entry point,
   * emitting the full `NodeOwnerRegistration` attestation via OPP and
   * escrowing the committed unit in BAR. The committer (the run's anvil
   * wallet) must already hold ≥ 1 unit of the tier's token (see
   * {@link MintSteps.planMint}) and have approved BAR as an ERC-1155
   * operator (see {@link planApproveEscrow}).
   *
   * @param actor - The narrative subject (the committing user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param tier - The claimed tier (= the ERC-1155 id committed).
   * @param wireAccountName - The Wire account the claim registers.
   * @param wirePublicKey - The account's claimed owner/active Wire key (`PUB_*`).
   * @returns The definition step.
   */
  export function planCommitNode<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    tier: NodeOwnerTier,
    wireAccountName: string,
    wirePublicKey: string
  ): ClusterBuildStep<C, CommitNodeInput> {
    return ClusterBuildStep.create<C, CommitNodeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "NodeOwnerNftScenarioCommitSteps.CommitNodeInput",
        tier,
        wireAccountName,
        wirePublicKey
      },
      runCommitNode
    )
  }

  /**
   * Named runner — ONE `BAR.commitNode` write. Resolves BAR from the deploy
   * artifacts (the WireNodes contract claims draw from is BAR's own
   * canonical config), converts the claimed Wire key to its proto
   * `WireKey`, and supplies the committer wallet's uncompressed secp256k1
   * public key as the depositor key.
   */
  export async function runCommitNode<C extends ClusterBuildContext>(
    ctx: C,
    input: CommitNodeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const bar = resolveBar(ctx),
      depositorPublicKey = ctx.ethereum.wallet.signer.signingKey.publicKey
    const receipt = await commitNode(
      bar,
      input.tier,
      input.wireAccountName,
      wireKeyFromPublicKey(input.wirePublicKey),
      depositorPublicKey
    )
    Assert.strictEqual(
      receipt.status,
      1,
      "BAR.commitNode: receipt status must be 1"
    )
  }
}
