import {
  type ClusterReadinessCheck,
  ClusterReadinessCheckStatus,
  type ClusterReadinessReasonCode
} from "@wireio/cluster-tool-shared"
import { getLogger, NestedError } from "@wireio/shared"

import {
  ReadinessAssertionError,
  type ReadinessAssertion,
  ReadinessContext,
  readinessPass
} from "../../readiness/ReadinessContext.js"
import type { StepInput } from "../StepRunner.js"

const log = getLogger(__filename)

/** Common metadata carried by every readiness check Step. */
export interface ReadinessCheckStepInput extends StepInput {
  readonly id: ClusterReadinessCheck["id"]
  readonly area: ClusterReadinessCheck["area"]
  readonly blocking: boolean
  readonly failureReason: ClusterReadinessReasonCode
}

/**
 * Execute one assertion, record its result, and throw only for blockers.
 *
 * @param context Connected readiness orchestration context.
 * @param input Stable check metadata and failure policy.
 * @param operation Read-only assertion operation.
 * @return Promise settled after the result is recorded.
 */
export async function runReadinessAssertion<I extends ReadinessCheckStepInput>(
  context: ReadinessContext,
  input: I,
  operation: () => Promise<ReadinessAssertion>
): Promise<void> {
  const metadata = {
    id: input.id,
    area: input.area,
    blocking: input.blocking
  }
  try {
    context.recordCheck(readinessPass(metadata, await operation()))
  } catch (error: unknown) {
    const assertionError =
        error instanceof ReadinessAssertionError ? error : null,
      reason = assertionError?.reason ?? input.failureReason,
      detail = error instanceof Error ? error.message : String(error),
      result: ClusterReadinessCheck = {
        ...metadata,
        status: input.blocking
          ? ClusterReadinessCheckStatus.fail
          : ClusterReadinessCheckStatus.advisory,
        reason,
        detail,
        ...(assertionError?.evidence
          ? { evidence: assertionError.evidence }
          : {})
      }
    log.warn(`Readiness check ${input.id} failed: ${detail}`)
    context.recordCheck(result)
    if (input.blocking) {
      throw new NestedError(detail, {
        cause: error,
        context: { checkId: input.id, reason }
      })
    }
  }
}
