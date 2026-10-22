import {
  ClusterBuildPhase,
  ClusterBuildStep,
  ClusterBuildPhaseGroup,
  outputKey,
  type ClusterBuildContext,
  type ClusterBuildPhaseBase,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { Deferred } from "@wireio/shared"

/**
 * Every phase / group name in a built cluster tree, in registration order,
 * recursing into groups to any depth.
 *
 * Composition tests assert on this list ("`MaterializeExternalOutposts` is
 * present in external mode", "`MockReserves` is absent without the flag"), so
 * it walks the REAL orchestration nodes: `name` comes from
 * {@link ClusterBuildPhaseBase} and the recursion narrows through
 * `instanceof ClusterBuildPhaseGroup`, which is the only node kind that carries
 * `children`. Passing `cluster.children` straight in therefore needs no
 * assertion of any kind — a phase is a leaf by its type, not by a hand-declared
 * `children?` shape.
 *
 * @param children - The build's (or a group's) registered children.
 * @returns Every descendant node name, parents before their children.
 */
export function collectPhaseNames<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>
): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child instanceof ClusterBuildPhaseGroup
      ? collectPhaseNames(child.children)
      : [])
  ])
}

/**
 * Every STEP name in a built cluster tree, in registration order — the
 * step-level companion to {@link collectPhaseNames}, recursing through groups
 * and reading each phase's public `steps`.
 *
 * Some composition is only observable at step granularity: a conditionally
 * composed step (an operator's ETH funding) lives INSIDE an
 * always-present phase, so a phase-name assertion cannot see it.
 *
 * @param children - The build's (or a group's) registered children.
 * @returns Every descendant step name, in registration order.
 */
export function collectStepNames<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>
): string[] {
  return children.flatMap(child =>
    child instanceof ClusterBuildPhaseGroup
      ? collectStepNames(child.children)
      : child instanceof ClusterBuildPhase
        ? child.steps.map(step => step.name)
        : []
  )
}

/**
 * Every step's Report actor in a built cluster tree, keyed by step name — the
 * actor-level companion to {@link collectStepNames}, recursing through groups
 * and reading each phase's public `steps`.
 *
 * @param children - The build's (or a group's) registered children.
 * @returns Each descendant step's name, mapped to its Report actor.
 */
export function collectStepActors<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>
): Map<string, Report.Actor> {
  return new Map(
    children.flatMap(child =>
      child instanceof ClusterBuildPhaseGroup
        ? [...collectStepActors(child.children)]
        : child instanceof ClusterBuildPhase
          ? child.steps.map(step => [step.name, step.actor] as const)
          : []
    )
  )
}

/**
 * The phase named `name` anywhere in a built cluster tree, recursing through groups — for
 * a composition test that inspects one phase's steps.
 *
 * @param children - The build's (or a group's) registered children.
 * @param name - The phase name.
 * @returns The first phase with that name, or nothing.
 */
export function findPhase<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>,
  name: string
): ClusterBuildPhase<C> {
  return children
    .flatMap(child =>
      child instanceof ClusterBuildPhaseGroup
        ? [findPhase(child.children, name)]
        : child instanceof ClusterBuildPhase && child.name === name
          ? [child]
          : []
    )
    .find(phase => phase != null)
}

/**
 * Default ceiling on how long a {@link rendezvous} waits for its last party. A
 * healthy run releases the moment the final party arrives, so this adds no wall
 * clock; it only bounds the failure mode — a runner that never starts the
 * parties together (e.g. a serial one) — turning the deadlock into a failing
 * step rather than a hung suite.
 */
export const RendezvousTimeoutMs = 5_000

/**
 * A one-shot barrier that proves concurrency without wall-clock margins: each
 * of `parties` callers invokes the returned function and its promise settles
 * only once ALL of them have arrived. A runner that starts the parties
 * concurrently releases them together; a serial runner never delivers the
 * second arrival, so the first party's wait hits the timeout and REJECTS (the
 * test fails — the timeout never passes it). Every arrival's timer is cleared
 * once its wait settles.
 *
 * @param parties - How many callers must arrive before any is released.
 * @param timeoutMs - Bound on each arrival's wait; defaults to {@link RendezvousTimeoutMs}.
 * @returns The arrive-and-wait function each party awaits.
 */
export function rendezvous(
  parties: number,
  timeoutMs: number = RendezvousTimeoutMs
): () => Promise<void> {
  let arrived = 0
  const allArrived = new Deferred<void>()
  return () => {
    arrived += 1
    if (arrived >= parties) allArrived.resolve()
    let handle: NodeJS.Timeout
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(
        () =>
          reject(
            new Error(
              `rendezvous: only ${arrived} of ${parties} parties arrived within ${timeoutMs}ms`
            )
          ),
        timeoutMs
      )
    })
    return Promise.race([allArrived.promise, timeout]).finally(() =>
      clearTimeout(handle)
    )
  }
}

/**
 * A step that records `start:<name>`, waits on `barrier`, then records
 * `end:<name>` into `order`. Run under a parallel runner, every start precedes
 * every end; under a serial one the barrier times out and the step fails.
 *
 * @param actor - Report subject.
 * @param name - Step name (also the marker suffix).
 * @param description - Report description.
 * @param options - Step execution options.
 * @returns A gated step using the context-owned probe.
 */
export function planGatedStep(
  actor: Report.Actor,
  name: string,
  description: string = name,
  options: ClusterBuildStepOptions = {}
): ClusterBuildStep<ClusterBuildContext, GatedStepInput> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    { kind: "clusterBuildFixture.GatedStepInput", name },
    runGatedStep
  )
}

/** Marker suffix carried as immutable step input. */
export interface GatedStepInput extends StepInput {
  /** Input discriminator. */
  readonly kind: "clusterBuildFixture.GatedStepInput"
  /** Name used in start / end markers. */
  readonly name: string
}

/** Live and peak in-flight counts shared by tracking steps. */
export interface InFlightCounter {
  /** Number of runners currently waiting at the barrier. */
  inFlight: number
  /** Largest simultaneous in-flight count observed. */
  peak: number
}

/** Synchronization and observations owned by the test context. */
export interface ConcurrencyProbe {
  /** Start / end markers recorded by gated runners. */
  order: string[]
  /** Live and peak observations recorded by tracking runners. */
  counter: InFlightCounter
  /** One-shot rendezvous shared by the context's runners. */
  barrier: () => Promise<void>
}

/** Typed context slot for concurrency test synchronization and observations. */
export const ConcurrencyProbeKey = outputKey<ConcurrencyProbe>(
  "test.concurrencyProbe",
  "Concurrency test barrier, order and in-flight counts"
)

/**
 * Record markers around the context-owned barrier.
 * @param ctx - Context holding the typed probe.
 * @param input - Immutable marker name.
 * @param _signal - Executor cancellation signal.
 * @returns Completion once the barrier releases.
 */
export async function runGatedStep(
  ctx: ClusterBuildContext,
  input: GatedStepInput,
  _signal: AbortSignal
): Promise<void> {
  const { order, barrier } = ctx.outputs.assert(ConcurrencyProbeKey)
  order.push(`start:${input.name}`)
  await barrier()
  order.push(`end:${input.name}`)
}

/**
 * A step that bumps `counter` while its body is in flight and holds on
 * `barrier`, so the first `parties` bodies are in flight together by
 * construction (the peak is reached without outlasting a sleep).
 *
 * @param actor - Report subject.
 * @param name - Step name.
 * @param description - Report description.
 * @param options - Step execution options.
 * @returns A tracking step using the context-owned probe.
 */
export function planInFlightTrackingStep(
  actor: Report.Actor,
  name: string,
  description: string = name,
  options: ClusterBuildStepOptions = {}
): ClusterBuildStep<ClusterBuildContext> {
  return ClusterBuildStep.create(
    actor,
    name,
    description,
    options,
    null,
    runInFlightTrackingStep
  )
}

/**
 * Count a runner's lifetime, including a rejected barrier.
 * @param ctx - Context holding the typed probe.
 * @param _input - This probe needs no input.
 * @param _signal - Executor cancellation signal.
 * @returns Completion after the barrier settles and the live count is released.
 */
export async function runInFlightTrackingStep(
  ctx: ClusterBuildContext,
  _input: null,
  _signal: AbortSignal
): Promise<void> {
  const { counter, barrier } = ctx.outputs.assert(ConcurrencyProbeKey)
  counter.inFlight += 1
  counter.peak = Math.max(counter.peak, counter.inFlight)
  try {
    await barrier()
  } finally {
    counter.inFlight -= 1
  }
}
