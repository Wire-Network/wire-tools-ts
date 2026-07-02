import type { ClusterBuildContext } from "./ClusterBuildContext.js"

/**
 * Marker base for every step's typed input. The `kind` string namespaces the
 * input (`"UserSteps.CreateInput"`) so a `Report.StepResult.input` dump is
 * self-describing.
 */
export interface StepInput {
  readonly kind: string
}

/**
 * A step's behavior: receives the context, its OWN typed input, and the phase
 * signal. Named functions only — never an inline arrow that closes over mutable
 * state (cross-step values flow through `ctx.outputs`).
 */
export type StepRunner<
  C extends ClusterBuildContext,
  I extends StepInput | null
> = (context: C, input: I, signal: AbortSignal) => Promise<void>
