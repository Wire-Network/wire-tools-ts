import {
  SolanaGenesisHashSchema,
  type SolanaGenesisHash
} from "@wireio/cluster-tool-shared"
import { Constants } from "../../Constants.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"
import { SolanaClusterIdentityKey } from "../outputs/index.js"

/**
 * Provision and verify the Solana genesis hash used by operator daemons.
 *
 * Local creation may trust the observed identity because the harness launched
 * and controls the validator. External endpoints must match independently
 * configured trust data exactly.
 */
export namespace SolanaClusterIdentitySteps {
  /** Provenance used when resolving the trusted Solana cluster identity. */
  export enum Source {
    local = "local",
    external = "external"
  }

  /** Input recorded for a Solana cluster-identity provisioning/verification step. */
  export interface ResolveInput extends StepInput {
    readonly kind: "SolanaClusterIdentitySteps.ResolveInput"
    readonly source: Source
    readonly expectedGenesisHash: SolanaGenesisHash | null
  }

  /**
   * Plan local identity provisioning immediately after validator startup.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The provisioning step.
   */
  export function planProvisionLocal<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ResolveInput> {
    return ClusterBuildStep.create<C, ResolveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaClusterIdentitySteps.ResolveInput",
        source: Source.local,
        expectedGenesisHash: null
      },
      runResolve
    )
  }

  /**
   * Plan external identity verification against independently configured trust.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param expectedGenesisHash - Independently configured expected identity.
   * @returns The verification step.
   */
  export function planVerifyExternal<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    expectedGenesisHash: SolanaGenesisHash
  ): ClusterBuildStep<C, ResolveInput> {
    return ClusterBuildStep.create<C, ResolveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaClusterIdentitySteps.ResolveInput",
        source: Source.external,
        expectedGenesisHash
      },
      runResolve
    )
  }

  /**
   * Query, validate, and optionally compare a Solana endpoint genesis hash.
   *
   * @param ctx - Cluster context whose Solana endpoint is queried.
   * @param input - Trust provenance and optional persisted/configured identity.
   * @param signal - Build cancellation signal.
   * @throws When the RPC is unavailable, either identity is malformed, or the
   * observed identity differs from the trusted expected identity.
   */
  export async function runResolve<C extends ClusterBuildContext>(
    ctx: C,
    input: ResolveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (input.source === Source.external && input.expectedGenesisHash == null) {
      throw new Error(
        "external Solana cluster identity requires an independently configured expected genesis hash"
      )
    }
    const expected =
      input.expectedGenesisHash == null
        ? null
        : parseGenesisHash(
            input.expectedGenesisHash,
            `${input.source} expected`
          )
    let reported: string
    try {
      reported = await withRpcDeadline(ctx.solana.getGenesisHash(), signal)
    } catch (cause) {
      const detail =
        cause instanceof Error && cause.message.length > 0
          ? `: ${cause.message}`
          : ""
      throw new Error(
        `${input.source} Solana endpoint getGenesisHash failed before operator launch${detail}`,
        { cause }
      )
    }
    signal.throwIfAborted()
    const observed = parseGenesisHash(
      reported,
      `${input.source} endpoint reported`
    )
    if (expected != null && observed !== expected) {
      throw new Error(
        `${input.source} Solana cluster identity mismatch: expected ${expected}, observed ${observed}`
      )
    }
    ctx.outputs.set(SolanaClusterIdentityKey, observed)
  }

  /** Parse a canonical 32-byte Base58 genesis hash with a contextual diagnostic. */
  function parseGenesisHash(value: string, label: string): SolanaGenesisHash {
    const parsed = SolanaGenesisHashSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `${label} an invalid Solana genesis hash: ${parsed.error.issues
          .map(issue => issue.message)
          .join("; ")}`
      )
    }
    return parsed.data
  }

  /** Bound a single identity RPC and stop waiting promptly when the build aborts. */
  function withRpcDeadline<T>(
    request: Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>,
      onAbort: () => void
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Solana genesis hash request aborted")
        )
      signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Solana getGenesisHash timed out after ${Constants.SOLANA_CLUSTER_IDENTITY_PROBE_TIMEOUT_MS}ms`
            )
        ),
        Constants.SOLANA_CLUSTER_IDENTITY_PROBE_TIMEOUT_MS
      )
      if (signal.aborted) onAbort()
    })
    return Promise.race([request, deadline]).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    })
  }
}
