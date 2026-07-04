import { getLogger } from "../logging/Logger.js"
import { ClusterBuildContext } from "./ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "./ClusterBuildStep.js"
import { Report } from "../report/Report.js"
import { sleep } from "../utils/asyncUtils.js"

const log = getLogger(__filename)

/**
 * Poll `predicate` on an interval until it resolves `true` or the deadline
 * elapses. Framework-free (no jest) so it runs inside a flow executable's step.
 * On timeout it throws `Timed out waiting for: <label> (<timeoutMs>ms)` — the
 * phase executor captures that into the step's `Report.ErrorDetail`.
 *
 * @param label - Human-readable description of what is being awaited.
 * @param predicate - Async check; `true` ends the poll.
 * @param timeoutMs - Deadline from now (ms).
 * @param intervalMs - Delay between checks (ms).
 * @throws If the deadline elapses before `predicate` is `true`.
 */
export async function pollUntil(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const scaledTimeoutMs = Math.round(timeoutMs * pollUntil.timeoutScale())
  const deadline = Date.now() + scaledTimeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(intervalMs)
  }
  log.error(`pollUntil timed out: ${label} (${scaledTimeoutMs}ms)`)
  throw new Error(`Timed out waiting for: ${label} (${scaledTimeoutMs}ms)`)
}

export namespace pollUntil {
  /**
   * Env var carrying a uniform deadline multiplier for EVERY flow poll.
   *
   * Flow budgets are wall-clock constants calibrated against nominal 60s
   * epochs on a dedicated machine. When several clusters share a host (the
   * e2e gate's FLOW_MAX_CONCURRENCY pool), the OPP pipeline's effective
   * cadence stretches — observed live (run 28685090729): epoch cadence ~2×
   * nominal, so fixed budgets fell below the epoch counts they were designed
   * for and four settlement waits timed out on healthy, progressing state.
   * The gate sets this ONCE for all flows (uniform env — never per-flow),
   * typically to the flow concurrency. Success paths are unaffected: polls
   * return the moment the predicate holds; only worst-case waits stretch.
   */
  export const TimeoutScaleEnvVar = "WIRE_FLOW_TIMEOUT_SCALE"
  /** Scale floor — never shrink budgets below their calibrated values. */
  export const MinTimeoutScale = 1
  /** Scale ceiling — a runaway value must not disable timeouts entirely. */
  export const MaxTimeoutScale = 5

  /**
   * The active deadline multiplier: `WIRE_FLOW_TIMEOUT_SCALE` clamped into
   * [{@link MinTimeoutScale}, {@link MaxTimeoutScale}]; 1 when unset/invalid.
   */
  export function timeoutScale(): number {
    const parsed = Number.parseFloat(process.env[TimeoutScaleEnvVar] ?? "")
    if (!Number.isFinite(parsed)) return MinTimeoutScale
    return Math.min(MaxTimeoutScale, Math.max(MinTimeoutScale, parsed))
  }
}

/**
 * Lift a verification closure into an input-less {@link ClusterBuildStep}. The
 * closure does the work AND its assertions (a thrown `Assert`/{@link pollUntil}
 * timeout is caught by the phase executor → `Report.StepStatus.failed` with the
 * full `ErrorDetail`). This is the flow-scenario analogue of a jest `it(...)`: a
 * named, actor-attributed step whose success is "it didn't throw".
 *
 * @param actor - The narrative subject (who performs/observes the check).
 * @param name - Step name (report row).
 * @param description - One-line description.
 * @param fn - The verification body; throws on failure.
 * @param options - Optional per-step tuning (e.g. `timeoutMs`).
 * @returns The definition step.
 */
export function verifyStep<C extends ClusterBuildContext = ClusterBuildContext>(
  actor: Report.Actor,
  name: string,
  description: string,
  fn: (ctx: C, signal: AbortSignal) => Promise<void>,
  options: ClusterBuildStepOptions = {}
): ClusterBuildStep<C, null> {
  return ClusterBuildStep.create<C, null>(
    actor,
    name,
    description,
    options,
    null,
    (ctx, _input, signal) => fn(ctx, signal)
  )
}

/**
 * Function lifter for poll-only step bodies. {@link lift} returns the step `fn`
 * itself — `(ctx: C) => Promise<void>` — NOT a step, so a poll step is
 * `ClusterBuildStep.create(..., pollStep.lift(label, predicate, timeoutMs, intervalMs))`
 * rather than a hand-written `async ctx => { await pollUntil(...) }`.
 */
export namespace pollStep {
  /**
   * Lift a context predicate into a step `fn` that polls it to a deadline.
   *
   * @param label - What is being awaited (for the timeout message).
   * @param predicate - Async check over the context; `true` ends the poll.
   * @param timeoutMs - Deadline from now (ms).
   * @param intervalMs - Delay between checks (ms).
   * @returns The step `fn` `(ctx) => Promise<void>`.
   */
  export function lift<C extends ClusterBuildContext = ClusterBuildContext>(
    label: string,
    predicate: (ctx: C) => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number
  ): (ctx: C) => Promise<void> {
    return ctx => pollUntil(label, () => predicate(ctx), timeoutMs, intervalMs)
  }
}
