import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"
import { SwapFromWireScenarioOutputs as Outputs } from "../SwapFromWireScenarioOutputs.js"

const { SysioContractName, SysioUwritChainkind } = SysioContracts

/**
 * Flow-local `sysio.uwrit` Steps — the queued from-WIRE swap entry point. The
 * shared palette (`Steps.contracts.sysio.uwrit`) carries no `swapfromwire`
 * factory yet, so the flow lifts the typed action invoke into its own
 * Report-validated write Step here.
 */
export namespace SwapFromWireScenarioUwritSteps {
  /** Input for {@link planSwapfromwire} — the swap's static scalars; the quoted
   *  target and the recipient identity resolve from `ctx.outputs` at run time. */
  export interface SwapfromwireInput extends StepInput {
    readonly kind: "SwapFromWireScenarioUwritSteps.SwapfromwireInput"
    /** The escrowing WIRE user (also the action authorizer). */
    readonly user: string
    /** Gross WIRE escrowed (raw 9-dec base units). */
    readonly wireAmount: bigint
    /** Destination chain slug value. */
    readonly destinationChainCode: number
    /** Destination token slug value. */
    readonly destinationTokenCode: number
    /** Destination reserve slug value. */
    readonly destinationReserveCode: number
    /** Variance tolerance carried on the request (bps). */
    readonly targetToleranceBps: number
  }

  /**
   * `sysio.uwrit::swapfromwire` — escrow the user's REAL WIRE into
   * `sysio.reserv` custody and enqueue the from-WIRE queue row (NO uwreq exists
   * until the next `sysio.epoch::advance` drains the queue).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param user - The escrowing WIRE account (authorizes the action).
   * @param wireAmount - Gross WIRE escrowed (raw base units).
   * @param destinationChainCode - Destination chain slug value.
   * @param destinationTokenCode - Destination token slug value.
   * @param destinationReserveCode - Destination reserve slug value.
   * @param targetToleranceBps - Variance tolerance (bps).
   * @returns The definition step.
   */
  export function planSwapfromwire<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    user: string,
    wireAmount: bigint,
    destinationChainCode: number,
    destinationTokenCode: number,
    destinationReserveCode: number,
    targetToleranceBps: number
  ): ClusterBuildStep<C, SwapfromwireInput> {
    return ClusterBuildStep.create<C, SwapfromwireInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapFromWireScenarioUwritSteps.SwapfromwireInput",
        user,
        wireAmount,
        destinationChainCode,
        destinationTokenCode,
        destinationReserveCode,
        targetToleranceBps
      },
      runSwapfromwire
    )
  }

  /**
   * Named runner — one `sysio.uwrit::swapfromwire` write, authorized by the
   * depositor. The target amount comes from the quote step's output; the
   * recipient is the provisioned swap user's Solana pubkey (this flow targets
   * the SVM outpost, hence `CHAIN_KIND_SVM` + the 32-byte ed25519 hex address).
   */
  export async function runSwapfromwire<C extends ClusterBuildContext>(
    ctx: C,
    input: SwapfromwireInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const targetAmount = ctx.outputs.assert(Outputs.targetSolanaAmount),
      swapUser = ctx.outputs.assert(swapUserOutputKey()),
      data: SysioContracts.SysioUwritSwapfromwireAction = {
        user: input.user,
        wire_amount: Number(input.wireAmount),
        dst_chain_code: { value: input.destinationChainCode },
        dst_token_code: { value: input.destinationTokenCode },
        dst_reserve_code: { value: input.destinationReserveCode },
        target_amount: Number(targetAmount),
        target_tolerance_bps: input.targetToleranceBps,
        recipient_kind: SysioUwritChainkind.CHAIN_KIND_SVM,
        recipient_addr: Buffer.from(swapUser.solanaPublicKeyBytes).toString("hex")
      }
    await ctx.wire
      .getSysioContract(SysioContractName.uwrit)
      .actions.swapfromwire.invoke(data, {
        authorization: [{ actor: input.user, permission: "active" }]
      })
  }
}
