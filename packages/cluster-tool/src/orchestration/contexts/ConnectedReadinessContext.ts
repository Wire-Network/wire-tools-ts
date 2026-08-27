import { ReadinessClient } from "../../clients/readiness/ReadinessClient.js"
import type { ReadinessConfig } from "../../config/ReadinessConfig.js"
import type { Logger } from "../../logging/Logger.js"
import { OrchestrationContext } from "../OrchestrationContext.js"

/** Capability required by reusable readiness Steps and PhaseGroups. */
export interface ReadinessCapable {
  /** Read-only clients and resolved readiness configuration. */
  readonly readiness: ReadinessClient
}

/** Connected orchestration context used by the standalone readiness CLI. */
export class ConnectedReadinessContext
  extends OrchestrationContext<ReadinessConfig>
  implements ReadinessCapable
{
  /** Read-only clients used by readiness runners. */
  readonly readiness: ReadinessClient

  /**
   * Create a connected context around explicit endpoints.
   *
   * @param config - Validated connected-readiness configuration.
   * @param log - Logger used by the orchestration engine.
   * @param request - Fetch implementation used by readiness clients.
   */
  constructor(
    config: ReadinessConfig,
    log: Logger,
    request: typeof fetch = globalThis.fetch
  ) {
    super(config, log)
    this.readiness = new ReadinessClient(config, request)
  }
}

/** Successful result returned by a readiness assertion. */
export interface ReadinessAssertion {
  /** Human-readable assertion result stored in the report. */
  detail: string
  /** Optional JSON-safe evidence stored in the report. */
  evidence?: Record<string, unknown>
}

/** Failure that carries structured readiness evidence into the native Report. */
export class ReadinessAssertionError extends Error {
  /** JSON-safe evidence attached to the failed readiness assertion. */
  readonly evidence: Record<string, unknown>

  /**
   * Create a readiness assertion failure.
   *
   * @param message - Human-readable failure reason.
   * @param evidence - JSON-safe supporting evidence.
   */
  constructor(message: string, evidence: Record<string, unknown> = {}) {
    super(message)
    this.evidence = evidence
    this.name = "ReadinessAssertionError"
  }
}

/**
 * Run one assertion and project its evidence onto the current native Step.
 *
 * @param context - Orchestration context carrying the readiness client.
 * @param operation - Read-only assertion operation.
 * @returns A promise resolved after evidence is recorded.
 */
export async function runReadinessAssertion<C extends ReadinessCapable>(
  context: C,
  operation: () => Promise<ReadinessAssertion>
): Promise<void> {
  try {
    const result = await operation()
    context.readiness.recordEvidence(result.detail, result.evidence)
  } catch (error: unknown) {
    if (error instanceof ReadinessAssertionError) {
      context.readiness.recordEvidence(error.message, error.evidence)
    }
    throw error
  }
}
