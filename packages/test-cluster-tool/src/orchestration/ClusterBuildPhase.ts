import Bluebird from "bluebird"
import { performance } from "node:perf_hooks"
import { match } from "ts-pattern"
import { Report } from "../report/Report.js"
import type { ClusterBuildContext } from "./ClusterBuildContext.js"
import {
  ClusterBuildPhaseBase,
  type ClusterBuildParent
} from "./ClusterBuildPhaseBase.js"
import { ClusterBuildStep, type ClusterBuildTaskOptions } from "./ClusterBuildStep.js"

/** Per-phase tuning (extends the shared base). `timeoutMs` is applied to each
 *  step lacking its own. */
export interface ClusterBuildPhaseOptions extends ClusterBuildTaskOptions {
  /** Run steps with `Promise.all` (shared AbortController) instead of in series. */
  parallelize?: boolean
}

/**
 * A phase — a GROUP of STEPS; a step is one unit of work. Built by the
 * {@link ClusterBuildPhase.create} factory (never `new`), generic over the
 * context `C`; the factory self-registers on the owning {@link ClusterBuildParent}
 * (`parent.push(this)`) and adopts its context. Steps run sequentially, or in
 * parallel when `options.parallelize` — a shared {@link AbortController} (linked
 * to the parent `signal`) short-circuits the remainder (sequential) / cancels
 * in-flight siblings (parallel) on the first failure. Steps never throw out of
 * here: each becomes a {@link Report.StepResult}.
 */
export class ClusterBuildPhase<
  C extends ClusterBuildContext = ClusterBuildContext
> extends ClusterBuildPhaseBase<C> {
  private readonly stepList: ClusterBuildStep.Any<C>[] = []

  private constructor(
    context: C,
    name: string,
    description: string,
    readonly options: ClusterBuildPhaseOptions
  ) {
    super(context, name, description)
  }

  /**
   * Factory — specify the context generic on the phase
   * (`ClusterBuildPhase.create<MyFlowContext>(parent, …)`); steps infer `C` when
   * added inline. Self-registers on `parent` (the build root or an enclosing group).
   */
  static create<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    steps: ClusterBuildStep.Any<C>[] = [],
    options: ClusterBuildPhaseOptions = {}
  ): ClusterBuildPhase<C> {
    const phase = new ClusterBuildPhase<C>(parent.context, name, description, options)
    phase.push(...steps)
    parent.push(phase)
    return phase
  }

  /** Externally read-only view of the registered steps. */
  get steps(): ReadonlyArray<ClusterBuildStep.Any<C>> {
    return this.stepList
  }

  /** Append step definitions (chainable). */
  push(...steps: ClusterBuildStep.Any<C>[]): this {
    this.stepList.push(...steps)
    return this
  }

  /**
   * Run every step and assemble a single {@link Report.Phase} (returned as a
   * one-element array to satisfy the {@link ClusterBuildPhaseBase} contract).
   * Sequential by default; parallel when `options.parallelize`. A pre-aborted
   * `signal` skips every step.
   */
  async run(signal: AbortSignal): Promise<Report.Phase[]> {
    const builder = new Report.PhaseBuilder(this.name, this.description, Date.now()),
      controller = new AbortController(),
      onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
    try {
      await match(this.options.parallelize ?? false)
        .with(true, async () => {
          const results = await Promise.all(
            this.stepList.map(step => this.runStep(step, controller))
          )
          builder.push(...results)
        })
        .with(false, () =>
          Bluebird.each(this.stepList, async step =>
            builder.push(await this.runStep(step, controller))
          )
        )
        .exhaustive()
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    return [builder.build()]
  }

  /**
   * Run one step under the shared controller. Abort-aware (an earlier sibling's
   * failure → `skipped`), timed, and total: it resolves to a StepResult and never
   * rejects, aborting the controller on failure so the phase short-circuits.
   */
  private async runStep(
    step: ClusterBuildStep.Any<C>,
    controller: AbortController
  ): Promise<Report.StepResult> {
    if (controller.signal.aborted) {
      this.context.log.info(
        `↷ Abort signalled by an earlier failure — step "${step.name}" will not be executed (skipped)`
      )
      return Report.StepResult.skipped(step)
    }

    const startedAt = performance.now()
    this.context.log.info(`▶ ${step.actor}: ${step.description}`)
    try {
      await runWithTimeout(
        signal => step.runner(this.context, step.input, signal),
        step.options.timeoutMs ?? this.options.timeoutMs ?? null,
        controller
      )
      return Report.StepResult.ok(step, performance.now() - startedAt)
    } catch (error) {
      controller.abort() // first-error: cancel siblings / skip the rest
      this.context.log.error(
        `✖ ${step.name}: ${error instanceof Error ? error.message : String(error)}`
      )
      return Report.StepResult.failed(step, performance.now() - startedAt, error)
    }
  }
}

/**
 * Race a step body against its timeout while threading the phase's AbortSignal.
 * A `null` budget means "no timeout". The body receives the signal so a
 * well-behaved step can bail cooperatively.
 */
function runWithTimeout(
  body: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number | null,
  controller: AbortController
): Promise<void> {
  if (!timeoutMs) return body(controller.signal)
  let handle: NodeJS.Timeout
  const timer = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      controller.abort()
      reject(new Error(`step exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    controller.signal.addEventListener("abort", () => clearTimeout(handle), {
      once: true
    })
  })
  // Settling the race MUST disarm the timer: a stale timeout left over from a
  // completed step would later fire and abort the SHARED phase controller,
  // silently skipping every remaining step in the phase.
  return Promise.race([body(controller.signal), timer]).finally(() =>
    clearTimeout(handle)
  )
}
