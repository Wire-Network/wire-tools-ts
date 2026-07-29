import { SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  abiEnumValue,
  AuthExLinkTool,
  ClusterBuildContext,
  ClusterBuildStep,
  ethereumPrivateKeyFromWallet,
  provisionWireUser,
  Report,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { EmissionsSoakScenarioConstants as Constants } from "../EmissionsSoakScenarioConstants.js"
import {
  controlledStakerWallet,
  type ControlledStakerIdentity
} from "../EmissionsSoakScenarioSyntheticDump.js"

const { SysioContractAccount, SysioContractName } = SysioContracts

/** `sysio.authex@active` — `linkswept` is an AUTHEX-authed sweep, mirroring the launch orchestrator. */
const AuthexActiveAuthorization = [
  {
    actor: SysioContractAccount[SysioContractName.authex],
    permission: "active"
  }
]

/**
 * Flow-local step factories for the emissions soak: claimer provisioning,
 * account-to-native linking, `linkswept`, per-staker claims, and the kiod
 * wallet unlock required after the long soak.
 */
export namespace EmissionsSoakScenarioSteps {
  // ── unlock the kiod wallet (client-side session state, idempotent) ────────

  /**
   * Open + unlock the cluster wallet. Kiod auto-locks after its unlock timeout,
   * which the 30-minute soak window always exceeds before claim actions run.
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

  // ── provision a claimer's WIRE account ─────────────────────────────────────

  /** Input for {@link planProvisionClaimer}. */
  export interface ProvisionClaimerInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ProvisionClaimerInput"
    readonly wireAccount: string
  }

  /**
   * Provision a controlled staker's WIRE account under the dev K1 key with the
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

  // ── authex-link a claimer's ETH wallet ─────────────────────────────────────

  /** Input for {@link planAuthexLink} — the staker identity (wallet re-derived from the HD index). */
  export interface AuthexLinkInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.AuthexLinkInput"
    readonly identity: ControlledStakerIdentity
  }

  /**
   * `sysio.authex::createlink` — link the staker's ETH wallet to its WIRE
   * account. The EM key identifies which ETH wallet "owns" the account; the
   * account still signs with the dev K1 key.
   */
  export function planAuthexLink<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    identity: ControlledStakerIdentity
  ): ClusterBuildStep<C, AuthexLinkInput> {
    return ClusterBuildStep.create<C, AuthexLinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.AuthexLinkInput", identity },
      runAuthexLink
    )
  }

  /** Named runner — re-derive the wallet, push the authex link. */
  export async function runAuthexLink<C extends ClusterBuildContext>(
    ctx: C,
    input: AuthexLinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = controlledStakerWallet(input.identity)
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: input.identity.wireAccount,
      privateKey: ethereumPrivateKeyFromWallet(wallet),
      ethereumWallet: wallet
    })
  }

  // ── sweep the staker's unmapped credit into pending_claims ────────────────

  /** Input for {@link planLinkswept}. */
  export interface LinksweptInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.LinksweptInput"
    readonly wireAccount: string
    /**
     * The exact bytes `importseed` stored for this staker — the 20-byte ETH
     * address as lower-case hex (NOT the 33-byte compressed pubkey); linkswept
     * matches on raw byte equality.
     */
    readonly nativePubkeyHex: string
  }

  /**
   * `sysio.dclaim::linkswept` — sweep the staker's `unmapped_tokens` row into
   * `pending_claims`. `createlink` does NOT auto-sweep; in a real launch an
   * off-chain orchestrator batches one sweep per new link — mirrored here.
   */
  export function planLinkswept<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string,
    nativePubkeyHex: string
  ): ClusterBuildStep<C, LinksweptInput> {
    return ClusterBuildStep.create<C, LinksweptInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EmissionsSoakScenarioSteps.LinksweptInput",
        wireAccount,
        nativePubkeyHex
      },
      runLinkswept
    )
  }

  /** Named runner — `sysio.dclaim::linkswept`, AUTHEX-authed. */
  export async function runLinkswept<C extends ClusterBuildContext>(
    ctx: C,
    input: LinksweptInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.linkswept.invoke(
        {
          wire_account: input.wireAccount,
          // Proto ChainKind → the dclaim ABI's own enum, bridged by VALUE.
          chain: abiEnumValue(
            SysioContracts.SysioDclaimChainkind,
            Constants.EthereumChain
          ),
          native_pubkey: input.nativePubkeyHex
        },
        { authorization: AuthexActiveAuthorization }
      )
  }

  // ── claim the staker's pending balance ─────────────────────────────────────

  /** Input for {@link planClaim}. */
  export interface ClaimInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ClaimInput"
    readonly wireAccount: string
  }

  /** `sysio.dclaim::claim` — drain the staker's pclaim row into WIRE (staker-authed). */
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

  /** Named runner — `sysio.dclaim::claim` authorized by the staker. */
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
