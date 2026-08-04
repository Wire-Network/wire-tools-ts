import type { ClusterBuildContext } from "./ClusterBuildContext.js"
import type { StepInput, StepRunner } from "./StepRunner.js"
import type { Report } from "../report/Report.js"

/** Shared base for phase + step options. Base is NOT `ClusterBuildOptions` —
 *  that already names the caller/config options. */
export interface ClusterBuildTaskOptions {
  /** Hard ceiling on the task's runner; on expiry the shared AbortSignal fires. */
  timeoutMs?: number
}

/** Per-step tuning. A step value overrides the phase default. */
export interface ClusterBuildStepOptions extends ClusterBuildTaskOptions {}

/**
 * A step is DATA + the behavior to run — ONE atomic unit of work, never the
 * thing that runs it (that's `ClusterBuildPhase`). Generic over the context `C`
 * AND a TYPED named input `I`: it stores `input: I` and a named {@link StepRunner}
 * (never a throwaway context-mutating lambda), so the executor records `input`
 * into the report automatically. **No public constructor** — build via
 * {@link ClusterBuildStep.create}. No `build()`/`execute()` here (definition vs
 * executor); it structurally satisfies `Report.StepLike`.
 */
export class ClusterBuildStep<
  C extends ClusterBuildContext = ClusterBuildContext,
  I extends StepInput | null = null
> {
  private constructor(
    readonly actor: Report.Actor,
    readonly name: string,
    readonly description: string,
    readonly options: ClusterBuildStepOptions,
    readonly input: I,
    readonly runner: StepRunner<C, I>
  ) {}

  /**
   * Factory — `(actor, name, description, options, input, runner)`. `actor`
   * (who/what takes the action) is FIRST. `input` is a named {@link StepInput}
   * (or `null` for input-less verify/poll steps); `runner` is a named function,
   * never an inline closure.
   *
   * @param actor - The narrative subject.
   * @param name - Short step name.
   * @param description - Human-readable description.
   * @param options - Step option overrides.
   * @param input - The step's typed input (or null).
   * @param runner - The behavior `(context, input, signal) => Promise<void>`.
   */
  static create<
    C extends ClusterBuildContext = ClusterBuildContext,
    I extends StepInput | null = null
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    input: I,
    runner: StepRunner<C, I>
  ): ClusterBuildStep<C, I> {
    return new ClusterBuildStep(actor, name, description, options, input, runner)
  }
}

export namespace ClusterBuildStep {
  /**
   * A step with its per-step input type erased, for the heterogeneous phase
   * collection: a phase holds steps of MANY different `I`, and `StepRunner<C, I>`
   * is contravariant in `I` (so `ClusterBuildStep<C, A>` is not assignable to
   * `ClusterBuildStep<C, B>`). The `any` erases `I` for storage ONLY — each
   * step's `runner` + `input` stay correlated WITHIN the step at runtime.
   */
  export type Any<C extends ClusterBuildContext = ClusterBuildContext> = ClusterBuildStep<C, any>

  /**
   * The shape every `Steps.*` factory returns: `(actor, name, description,
   * options, ...domainArgs) => ClusterBuildStep<C, I>` — `actor` FIRST.
   */
  export type Factory<
    Args extends unknown[] = unknown[],
    C extends ClusterBuildContext = ClusterBuildContext,
    I extends StepInput | null = null
  > = (
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ...args: Args
  ) => ClusterBuildStep<C, I>
}
