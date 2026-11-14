/**
 * EthereumFundingTool — the harness's local-chain Ethereum identities and their
 * funding, the Ethereum counterpart of `SolanaFundingTool`'s keypair + airdrop
 * surface. Every actor the harness itself acts as on the run anvil — the
 * outpost deployer, the emergency-stop panic account, a mock backer, a flow's
 * holder — is a RANDOM wallet persisted under a durable handle
 * (`EthereumWallet.saveWallet`) and funded through `anvil_setBalance`
 * (`EthereumClient.setBalance`), the local chain's faucet. Nothing derives from
 * a mnemonic or draws on an anvil genesis account.
 *
 * Per the orchestration model each write is its own Step:
 * {@link EthereumFundingTool.planCreateWallet} (generate + persist, recorded by
 * identity) and {@link EthereumFundingTool.planSetBalance} (ONE
 * `anvil_setBalance`). The signer and compressed-key helpers are pure value
 * helpers the runners of other tools call.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { KeyType } from "@wireio/sdk-core"
import { EthereumWallet } from "../../clients/ethereum/EthereumWallet.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import type { EthereumKeyPair } from "../../types/KeyPair.js"
import { ethereumCompressedPubkey } from "../../utils/keyPairUtils.js"

export namespace EthereumFundingTool {
  /**
   * Balance the outpost DEPLOYER is funded to: it pays every contract deploy
   * of `deployLocal.ts` and every `OutpostManager.execute` admin write for the
   * run, so it is sized far past any of them.
   */
  export const DeployerBalanceWei = 100_000n * ethers.WeiPerEther
  /** Balance the PANIC account is funded to: a handful of `pause` / `unpause` calls. */
  export const PanicBalanceWei = 10n * ethers.WeiPerEther

  // ── Step: generate + persist a wallet under its handle ───────────────────

  /** Input for {@link planCreateWallet}. */
  export interface CreateWalletInput extends StepInput {
    readonly kind: "EthereumFundingTool.CreateWalletInput"
    /** The wallet's durable handle. */
    readonly walletName: string
    /** What the wallet is FOR — lands in the keygen record. */
    readonly purpose: string
  }

  /**
   * Generate a random wallet through the `KeyGenerator` facade and persist it
   * under `walletName`; a handle already holding a wallet is left as it is, so
   * the Step is idempotent across a re-run. The generated identity (public half
   * only) lands in the step's `extra`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param walletName - The wallet's durable handle.
   * @param purpose - What the wallet is for.
   * @returns The definition step.
   */
  export function planCreateWallet<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    walletName: string,
    purpose: string
  ): ClusterBuildStep<C, CreateWalletInput> {
    return ClusterBuildStep.create<C, CreateWalletInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumFundingTool.CreateWalletInput", walletName, purpose },
      runCreateWallet
    )
  }

  /** Named runner — generate (once) and persist the wallet under its handle. */
  export async function runCreateWallet<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateWalletInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { dataPath } = ctx.config,
      existed = EthereumWallet.hasWallet(dataPath, input.walletName),
      wallet = await createWallet(
        dataPath,
        input.walletName,
        KeySteps.keyGeneratorContext(ctx),
        input.purpose
      )
    if (existed) {
      StepExtraRecorder.note(
        `Ethereum wallet "${input.walletName}" already exists — kept`,
        { walletName: input.walletName, address: wallet.address }
      )
    }
  }

  /**
   * Get-or-create a persisted wallet under its handle: a random pair from the
   * `KeyGenerator` facade, persisted once; a handle already holding a wallet
   * is read back verbatim, so a re-run keeps the identity. The ONE
   * get-or-create every wallet site uses — {@link runCreateWallet} inside a
   * Step, and a scenario's pre-bootstrap stage (`FlowScenario.prepare`) that
   * must know its holders' addresses before the cluster is composed.
   *
   * @param dataPath - The cluster data directory.
   * @param walletName - The wallet's durable handle.
   * @param keyContext - The key-generation tooling.
   * @param purpose - What the wallet is for (lands in the keygen record).
   * @returns The persisted pair.
   */
  export async function createWallet(
    dataPath: string,
    walletName: string,
    keyContext: KeyGenerator.Context,
    purpose: string
  ): Promise<EthereumKeyPair> {
    return EthereumWallet.hasWallet(dataPath, walletName)
      ? EthereumWallet.loadKeyPair(dataPath, walletName)
      : EthereumWallet.saveWallet(
          dataPath,
          walletName,
          await KeyGenerator.create(KeyType.EM, keyContext, { purpose })
        )
  }

  // ── Step: fund a persisted wallet (`anvil_setBalance`) ───────────────────

  /** Input for {@link planSetBalance} — ONE `anvil_setBalance` write. */
  export interface SetBalanceInput extends StepInput {
    readonly kind: "EthereumFundingTool.SetBalanceInput"
    /** The wallet's durable handle. */
    readonly walletName: string
    /** The balance the wallet is set to, in wei. */
    readonly balanceWei: bigint
  }

  /**
   * Set the persisted wallet's balance on the run anvil — the local faucet.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param walletName - The wallet's durable handle.
   * @param balanceWei - The balance to set, in wei.
   * @returns The definition step.
   */
  export function planSetBalance<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    walletName: string,
    balanceWei: bigint
  ): ClusterBuildStep<C, SetBalanceInput> {
    return ClusterBuildStep.create<C, SetBalanceInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumFundingTool.SetBalanceInput", walletName, balanceWei },
      runSetBalance
    )
  }

  /** Named runner — ONE `anvil_setBalance` on the wallet's address. */
  export async function runSetBalance<C extends ClusterBuildContext>(
    ctx: C,
    input: SetBalanceInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.balanceWei > 0n,
      "EthereumFundingTool.planSetBalance: balanceWei must be positive"
    )
    await ctx.ethereum.setBalance(
      EthereumWallet.loadKeyPair(ctx.config.dataPath, input.walletName).address,
      input.balanceWei
    )
  }

  // ── value helpers ────────────────────────────────────────────────────────

  /**
   * The persisted wallet, connected to the run's provider — what a runner signs
   * its outpost writes with.
   *
   * @param ctx - The build context (supplies the data path and the provider).
   * @param walletName - The wallet's durable handle.
   * @returns The connected signer.
   */
  export function signer<C extends ClusterBuildContext>(
    ctx: C,
    walletName: string
  ): ethers.Wallet {
    return EthereumWallet.loadWallet(
      ctx.config.dataPath,
      walletName,
      ctx.ethereum.provider
    )
  }

  /**
   * The 33-byte compressed secp256k1 public key of the persisted wallet, as
   * `0x` hex — the `compressedPubkey` `SyndicationPool.syndicate` needs, which
   * must derive to the sender. A pure value helper.
   *
   * @param ctx - The build context (supplies the data path).
   * @param walletName - The wallet's durable handle.
   * @returns The compressed key.
   */
  export function compressedPubkey<C extends ClusterBuildContext>(
    ctx: C,
    walletName: string
  ): string {
    return ethers.hexlify(
      ethereumCompressedPubkey(
        EthereumWallet.loadKeyPair(ctx.config.dataPath, walletName)
      )
    )
  }
}
