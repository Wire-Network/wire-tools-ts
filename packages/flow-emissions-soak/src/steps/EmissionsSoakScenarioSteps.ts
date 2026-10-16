import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildContext,
  ClusterBuildStep,
  EthereumLadderImportKey,
  Report,
  Steps,
  formatWireAsset,
  provisionWireUser,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { EmissionsSoakScenarioConstants as Constants } from "../EmissionsSoakScenarioConstants.js"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Flow-local step factories for the emissions soak: the dclaim pre-fund sized
 * to the claimants' seeded credits, claimant provisioning, the per-claimant
 * claim, and the kiod wallet unlock performed before each write burst. The
 * claimants link their Ethereum keys through
 * `Steps.ethereumLadderImport.planLinkActor`.
 */
export namespace EmissionsSoakScenarioSteps {
  // ── unlock the kiod wallet (client-side session state, idempotent) ────────

  /**
   * Open + unlock the cluster wallet. The old suite ran `walletOpenAndUnlock`
   * before the import and claim bursts — kiod auto-locks after its unlock
   * timeout, which the 30-minute soak window always exceeds.
   */
  export function planUnlockWallet<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runUnlockWallet
    )
  }

  /** Named runner — open + unlock the default kiod wallet. */
  export async function runUnlockWallet<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.wallet.unlock()
  }

  // ── the claimants' seeded credits ──────────────────────────────────────────

  /**
   * The WIRE atomic the ladder import seeded for a claimant (a read of the
   * derived import the bootstrap published).
   */
  export function seededAtomic(ctx: ClusterBuildContext, claimant: Constants.Claimant): bigint {
    return BigInt(
      Steps.ethereumLadderImport.actorSeedCredit(
        ctx.outputs.assert(EthereumLadderImportKey),
        claimant.actorIndex
      ).wire_atomic
    )
  }

  // ── pre-fund dclaim for the claimants' payouts ─────────────────────────────

  /** Input for {@link planPrefundDclaim}: the claimants whose seeded credits size the transfer. */
  export interface PrefundDclaimInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.PrefundDclaimInput"
    readonly claimants: Constants.Claimant[]
  }

  /**
   * `sysio.token::transfer` from `sysio` to `sysio.dclaim` of exactly the
   * claimants' seeded credits — a real launch pre-funds DClaim the same way.
   */
  export function planPrefundDclaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    claimants: Constants.Claimant[]
  ): ClusterBuildStep<C, PrefundDclaimInput> {
    return ClusterBuildStep.create<C, PrefundDclaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.PrefundDclaimInput", claimants },
      runPrefundDclaim
    )
  }

  /** Named runner — ONE transfer, its quantity summed from the seeded credits. */
  export async function runPrefundDclaim<C extends ClusterBuildContext>(
    ctx: C,
    input: PrefundDclaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const total = input.claimants.reduce(
      (sum, claimant) => sum + seededAtomic(ctx, claimant),
      0n
    )
    await Steps.contracts.sysio.token.runTransfer(
      ctx,
      {
        kind: "TokenContractSteps.TransferInput",
        data: {
          from: SysioContractAccount[SysioContractName.system],
          to: SysioContractAccount[SysioContractName.dclaim],
          quantity: formatWireAsset(total),
          memo: Constants.PreFundMemo
        }
      },
      signal
    )
  }

  // ── provision a claimer's WIRE account ─────────────────────────────────────

  /** Input for {@link planProvisionClaimer}. */
  export interface ProvisionClaimerInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ProvisionClaimerInput"
    readonly wireAccount: string
  }

  /**
   * Provision a claimant's WIRE account under the dev K1 key with the
   * standard resource policy (the account must host its authex link + pclaim
   * row) — the harness's ONE user-provisioning mechanism, unfunded.
   */
  export function planProvisionClaimer<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string
  ): ClusterBuildStep<C, ProvisionClaimerInput> {
    return ClusterBuildStep.create<C, ProvisionClaimerInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.ProvisionClaimerInput", wireAccount },
      runProvisionClaimer
    )
  }

  /** Named runner — `provisionWireUser` (create account + resource policy). */
  export async function runProvisionClaimer<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionClaimerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.wireAccount)
  }

  // ── claim the claimant's pending balance ───────────────────────────────────

  /** Input for {@link planClaim}. */
  export interface ClaimInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ClaimInput"
    readonly wireAccount: string
  }

  /** `sysio.dclaim::claim` — drain the claimant's pclaim row into WIRE (claimant-authed). */
  export function planClaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string
  ): ClusterBuildStep<C, ClaimInput> {
    return ClusterBuildStep.create<C, ClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.ClaimInput", wireAccount },
      runClaim
    )
  }

  /** Named runner — `sysio.dclaim::claim` authorized by the claimant. */
  export async function runClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.claim.invoke(
        { wire_account: input.wireAccount },
        { authorization: [{ actor: input.wireAccount, permission: "active" }] }
      )
  }
}
