import { JsonRpcProvider } from "@ethersproject/providers"
import { Connection } from "@solana/web3.js"
import {
  ClusterReadinessArea,
  ClusterReadinessCheckId,
  ClusterReadinessEndpointKind,
  ClusterReadinessReasonCode
} from "@wireio/cluster-tool-shared"
import {
  OutpostChainFamily,
  OutpostDeploymentVerifier,
  type OutpostDeploymentProfile
} from "@wireio/sdk-outpost"

import {
  ReadinessAssertionError,
  ReadinessContext
} from "../../readiness/ReadinessContext.js"
import type { Report } from "../../report/Report.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import {
  runReadinessAssertion,
  type ReadinessCheckStepInput
} from "./ReadinessStepTools.js"

interface OutpostDeploymentReadinessInput extends ReadinessCheckStepInput {
  readonly kind: "OutpostDeploymentReadinessSteps.Input"
}

/** Read-only Step factories for exact outpost deployment identity. */
export namespace OutpostDeploymentReadinessSteps {
  /**
   * Plan the Wire-to-profile identity check.
   *
   * @param actor - Report actor responsible for the observation.
   * @param name - Stable Step name.
   * @param description - Operator-facing Step description.
   * @param options - Orchestration options for the Step.
   * @returns A read-only Wire deployment-profile Step.
   */
  export function planWireDeploymentProfile(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ReadinessContext, OutpostDeploymentReadinessInput> {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["wire.deployment-profile"],
      runWireDeploymentProfile
    )
  }

  /**
   * Plan exact Ethereum proxy and implementation verification.
   *
   * @param actor - Report actor responsible for the observation.
   * @param name - Stable Step name.
   * @param description - Operator-facing Step description.
   * @param options - Orchestration options for the Step.
   * @returns A read-only Ethereum deployment-profile Step.
   */
  export function planEthereumDeploymentProfile(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ReadinessContext, OutpostDeploymentReadinessInput> {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["ethereum.deployment-profile"],
      runEthereumDeploymentProfile
    )
  }

  /**
   * Plan exact Solana ProgramData verification.
   *
   * @param actor - Report actor responsible for the observation.
   * @param name - Stable Step name.
   * @param description - Operator-facing Step description.
   * @param options - Orchestration options for the Step.
   * @returns A read-only Solana deployment-profile Step.
   */
  export function planSolanaDeploymentProfile(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<ReadinessContext, OutpostDeploymentReadinessInput> {
    return plan(
      actor,
      name,
      description,
      options,
      ClusterReadinessCheckId["solana.deployment-profile"],
      runSolanaDeploymentProfile
    )
  }
}

function plan(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  id: ClusterReadinessCheckId,
  runner: (
    context: ReadinessContext,
    input: OutpostDeploymentReadinessInput,
    signal: AbortSignal
  ) => Promise<void>
): ClusterBuildStep<ReadinessContext, OutpostDeploymentReadinessInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    {
      kind: "OutpostDeploymentReadinessSteps.Input",
      id,
      area: ClusterReadinessArea.cluster,
      blocking: true,
      failureReason: ClusterReadinessReasonCode["version-incompatible"]
    },
    runner
  )
}

/**
 * Verify the connected Wire chain against the deployment profile.
 *
 * @param context - Connected readiness context.
 * @param input - Stable check metadata.
 * @param signal - Step cancellation signal.
 * @returns A promise settled after the check is recorded.
 */
export async function runWireDeploymentProfile(
  context: ReadinessContext,
  input: OutpostDeploymentReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    context.assertEndpoint(ClusterReadinessEndpointKind.wire)
    const profile = assertOutpostDeploymentProfile(context),
      info = await context.wireApi.v1.chain.get_info(),
      observed = info.chain_id.toString().toLowerCase(),
      expected = profile.wire.chainId.toLowerCase()
    if (observed !== expected) {
      throw new ReadinessAssertionError(
        `Wire deployment profile expected ${expected}, received ${observed}`,
        ClusterReadinessReasonCode["version-incompatible"],
        { profileId: profile.id, expected, observed }
      )
    }
    return {
      detail: `Wire chain matches deployment profile ${profile.id}`,
      evidence: { profileId: profile.id, chainId: observed }
    }
  })
}

/**
 * Verify exact live Ethereum implementations against the deployment profile.
 *
 * @param context - Connected readiness context.
 * @param input - Stable check metadata.
 * @param signal - Step cancellation signal.
 * @returns A promise settled after the check is recorded.
 */
export async function runEthereumDeploymentProfile(
  context: ReadinessContext,
  input: OutpostDeploymentReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const profile = assertOutpostDeploymentProfile(context),
      endpoint = context.assertEndpoint(ClusterReadinessEndpointKind.ethereum)
    await OutpostDeploymentVerifier.verify({
      family: OutpostChainFamily.ethereum,
      profile,
      provider: new JsonRpcProvider(endpoint.url)
    })
    return {
      detail: `Ethereum implementations match deployment profile ${profile.id}`,
      evidence: {
        profileId: profile.id,
        chainId: profile.ethereum.chainId,
        contracts: Object.keys(profile.ethereum.contracts)
      }
    }
  })
}

/**
 * Verify exact live Solana ProgramData against the deployment profile.
 *
 * @param context - Connected readiness context.
 * @param input - Stable check metadata.
 * @param signal - Step cancellation signal.
 * @returns A promise settled after the check is recorded.
 */
export async function runSolanaDeploymentProfile(
  context: ReadinessContext,
  input: OutpostDeploymentReadinessInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  await runReadinessAssertion(context, input, async () => {
    const profile = assertOutpostDeploymentProfile(context),
      endpoint = context.assertEndpoint(ClusterReadinessEndpointKind.solana)
    await OutpostDeploymentVerifier.verify({
      family: OutpostChainFamily.solana,
      profile,
      connection: new Connection(endpoint.url)
    })
    return {
      detail: `Solana ProgramData matches deployment profile ${profile.id}`,
      evidence: {
        profileId: profile.id,
        genesisHash: profile.solana.genesisHash,
        programs: Object.keys(profile.solana.programs)
      }
    }
  })
}

function assertOutpostDeploymentProfile(
  context: ReadinessContext
): OutpostDeploymentProfile {
  const { outpostDeploymentProfile } = context.config
  if (!outpostDeploymentProfile) {
    throw new ReadinessAssertionError(
      "Outpost deployment profile is not configured",
      ClusterReadinessReasonCode["configuration-incomplete"]
    )
  }
  return outpostDeploymentProfile
}
