import { ChainKind } from "@wireio/opp-typescript-models"
import {
  AuthExLinkTool,
  ClusterBuildStep,
  Report,
  ethereumPrivateKeyFromWallet,
  provisionWireUser,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/test-cluster-tool"

/**
 * Flow-local Step factories for the reserve OWNER provisioning writes: the
 * WIRE matcher accounts (create + policy + funding via the harness's
 * `provisionWireUser`) and the `sysio.authex::createlink` binding the matcher
 * to the reserve creator's Ethereum key. Every on-chain WRITE is its own
 * {@link ClusterBuildStep} so the `Report` records it.
 */
export namespace ReserveLifecycleScenarioOwnerSteps {
  // ── Step: provision a WIRE user (create + policy + optional funding) ──────

  /** Input for {@link provisionUser} — one WIRE-user provisioning write set. */
  export interface ProvisionUserInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioOwnerSteps.ProvisionUserInput"
    /** WIRE account name to provision (1..12 chars, base32 alphabet). */
    readonly account: string
    /** Raw 9-decimal WIRE base units transferred from the `sysio` treasury. */
    readonly fundWireAmount: bigint
  }

  /**
   * Provision one WIRE user account via the harness's `provisionWireUser`
   * (idempotent create under the dev key + resource policy + treasury funding).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param account - WIRE account name to provision.
   * @param fundWireAmount - Raw WIRE base units to fund the account with.
   * @returns The definition step.
   */
  export function provisionUser<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    fundWireAmount: bigint
  ): ClusterBuildStep<C, ProvisionUserInput> {
    return ClusterBuildStep.create<C, ProvisionUserInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioOwnerSteps.ProvisionUserInput",
        account,
        fundWireAmount
      },
      runProvisionUser
    )
  }

  /** Named runner — provision the account through the harness helper. */
  export async function runProvisionUser<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionUserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.account, {
      fundWireAmount: input.fundWireAmount
    })
  }

  // ── Step: authex link (matcher ↔ the creator wallet's secp256k1 key) ──────

  /** Input for {@link createLink} — one `sysio.authex::createlink` write. */
  export interface CreateLinkInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioOwnerSteps.CreateLinkInput"
    /** WIRE account the creator key is linked TO. */
    readonly account: string
  }

  /**
   * Bind `account` to the swap-user (reserve creator) wallet's secp256k1 key
   * via `sysio.authex::createlink`. The depot's `oncrtreserve` accepts the
   * create because the CREATOR key has a link; `matchreserve` later requires
   * the MATCHER's link key to equal the creator key — this single link
   * satisfies both sides.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param account - WIRE account to link the creator key to.
   * @returns The definition step.
   */
  export function createLink<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, CreateLinkInput> {
    return ClusterBuildStep.create<C, CreateLinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReserveLifecycleScenarioOwnerSteps.CreateLinkInput", account },
      runCreateLink
    )
  }

  /** Named runner — ONE EVM `createlink` write, signed with the creator wallet key. */
  export async function runCreateLink<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateLinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: input.account,
      privateKey: ethereumPrivateKeyFromWallet(swapUser.ethereumWallet),
      ethereumWallet: swapUser.ethereumWallet
    })
  }
}
