import type { OppStressRampIterationInput } from "./rampControllerTypes.js"

/** Resolution state of one callback invocation at the controller boundary. */
export type SettledRampIteration =
  | { readonly kind: "resolved"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly cause: unknown }

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
