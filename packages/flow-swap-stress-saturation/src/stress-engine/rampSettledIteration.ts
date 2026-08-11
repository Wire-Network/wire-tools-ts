import type { OppStressRampIterationInput } from "./rampControllerTypes.js"

/** Callback invocation that resolved with an uninterpreted observation. */
interface ResolvedRampIteration {
  readonly kind: "resolved"
  readonly value: unknown
}

/** Callback invocation that rejected with an exact retained cause. */
interface RejectedRampIteration {
  readonly kind: "rejected"
  readonly cause: unknown
}

/** Resolution state of one callback invocation at the controller boundary. */
export type SettledRampIteration =
  | ResolvedRampIteration
  | RejectedRampIteration

/**
 * Capture callback resolution without interpreting its returned observation.
 * @param runIteration Typed callback invoked once for the iteration.
 * @param input Controller-owned iteration identity and count.
 * @returns Resolved unknown value or exact rejection cause.
 */
export async function settleRampIteration(
  runIteration: (input: OppStressRampIterationInput) => Promise<unknown>,
  input: OppStressRampIterationInput
): Promise<SettledRampIteration> {
  try {
    return { kind: "resolved", value: await runIteration(input) }
  } catch (cause) {
    return { kind: "rejected", cause }
  }
}
