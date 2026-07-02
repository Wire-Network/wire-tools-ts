import { promises as Fsp } from "node:fs"
import Path from "node:path"
import { getLogger } from "@wireio/shared"
import type { ReportRendererRegistry } from "./ReportRendererRegistry.js"

const log = getLogger("Report")

/**
 * The complete run narrative — phases of actor-by-actor steps. Built up as a
 * ClusterBuild runs (each `ClusterBuildPhase.build()` returns a
 * {@link Report.Phase}), then rendered to every configured {@link Report.Format}.
 *
 * `Report` is BOTH this class and a companion namespace (below) carrying the
 * report domain types, the phase builder, and the step/error factories.
 */
export class Report {
  private readonly phaseList: Report.Phase[] = []

  /** The phases recorded so far — internally mutable, externally read-only. */
  get phases(): ReadonlyArray<Report.Phase> {
    return this.phaseList
  }

  /** True when every phase succeeded. */
  get succeeded(): boolean {
    return this.phaseList.every(phase => phase.succeeded)
  }

  /** Append finished phases (variadic, fluent). */
  push(...phases: Report.Phase[]): Report {
    this.phaseList.push(...phases)
    return this
  }

  /**
   * Render this report to every `config.formats` entry, writing
   * `<config.path>/<config.basename>.<format>`. The `registry` is supplied by
   * the caller (no rendering dependency is baked into this class).
   *
   * @param config - Where + which formats to write.
   * @param registry - The renderer registry (e.g. `ReportRendererRegistry.createDefault()`).
   */
  async write(
    config: Report.Config,
    registry: ReportRendererRegistry
  ): Promise<void> {
    await Fsp.mkdir(config.path, { recursive: true })
    await Promise.all(
      config.formats.map(format => this.writeOne(config, format, registry))
    )
  }

  private async writeOne(
    config: Report.Config,
    format: Report.Format,
    registry: ReportRendererRegistry
  ): Promise<void> {
    const Ctor = registry.get(format)
    const file = Path.join(config.path, `${config.basename}.${format}`)
    await Fsp.writeFile(file, new Ctor(this).render(), "utf8")
    log.info("Report written: %s", file)
  }
}

export namespace Report {
  /** Who performed a step — the narrative's subject. String value === key. */
  export enum Actor {
    Sysio = "Sysio",
    Producer = "Producer",
    BatchOperator = "BatchOperator",
    Underwriter = "Underwriter",
    User = "User",
    EthereumOutpost = "EthereumOutpost",
    SolanaOutpost = "SolanaOutpost"
  }

  /** Output format — value matches the file extension. */
  export enum Format {
    csv = "csv",
    md = "md",
    html = "html"
  }

  /** Per-step outcome. */
  export enum StepStatus {
    ok = "ok",
    failed = "failed",
    skipped = "skipped"
  }

  /** Full failure detail — every slot present (null when absent) so it survives JSON. */
  export interface ErrorDetail {
    message: string
    stack: string | null
    processOutput: string | null
    input: unknown | null
  }

  /** One row of the narrative. */
  export interface StepResult {
    name: string
    description: string
    actor: Actor
    status: StepStatus
    startedAt: string
    durationMs: number
    input: unknown | null
    error: ErrorDetail | null
  }

  /** A built phase of the narrative. */
  export interface Phase {
    name: string
    description: string
    steps: ReadonlyArray<StepResult>
    succeeded: boolean
    durationMs: number
  }

  /** Derived readings over a {@link Phase} shared by the renderers. */
  export namespace Phase {
    /**
     * Count of steps that never ran (an abort skipped them). Rendered next to
     * the phase verdict — a phase with no failures but a skipped tail must
     * not read as a clean `[OK]`.
     */
    export function skippedCount(phase: Phase): number {
      return phase.steps.filter(step => step.status === StepStatus.skipped)
        .length
    }
  }

  /** Caller-facing write target — the resolved `Config`. */
  export interface Config {
    path: string
    basename: string
    formats: Format[]
  }

  /** The optional, caller-supplied form of {@link Config}. */
  export type Options = Partial<Config>

  /** The minimal step shape the {@link StepResult} factories need (a
   *  `ClusterBuildStep` satisfies it structurally — no orchestration import). */
  export interface StepLike {
    readonly name: string
    readonly description: string
    readonly actor: Actor
    readonly input: unknown
  }

  /**
   * Accumulates a phase's step results, then freezes them into a {@link Phase}.
   * Created by `ClusterBuildPhase.build()`; one `push` per executed step.
   */
  export class PhaseBuilder {
    private readonly results: StepResult[] = []

    constructor(
      readonly name: string,
      readonly description: string,
      private readonly startedAtMs: number
    ) {}

    /** Record one or more step results (variadic, fluent). */
    push(...results: StepResult[]): PhaseBuilder {
      this.results.push(...results)
      return this
    }

    /** Freeze into an immutable {@link Phase}. */
    build(): Phase {
      return {
        name: this.name,
        description: this.description,
        steps: this.results,
        // Every step must be ok — a skipped step means work that never ran,
        // and a phase whose steps never ran did not succeed. (A "no step
        // failed" predicate let a skipped tail render as a passing phase.)
        succeeded: this.results.every(
          result => result.status === StepStatus.ok
        ),
        durationMs: Date.now() - this.startedAtMs
      }
    }
  }

  /** Factories for {@link StepResult}, keyed off a {@link StepLike}. */
  export namespace StepResult {
    function base(
      step: StepLike,
      status: StepStatus,
      durationMs: number,
      error: ErrorDetail | null
    ): StepResult {
      return {
        name: step.name,
        description: step.description,
        actor: step.actor,
        status,
        startedAt: new Date(Date.now() - durationMs).toISOString(),
        durationMs,
        input: step.input ?? null,
        error
      }
    }
    /** A successful step result. */
    export function ok(step: StepLike, durationMs: number): StepResult {
      return base(step, StepStatus.ok, durationMs, null)
    }
    /** A failed step result (builds the ErrorDetail from `error` + the step input). */
    export function failed(
      step: StepLike,
      durationMs: number,
      error: unknown
    ): StepResult {
      return base(
        step,
        StepStatus.failed,
        durationMs,
        ErrorDetail.from(error, step.input)
      )
    }
    /** A skipped step result (an earlier sibling failed → this never ran). */
    export function skipped(step: StepLike): StepResult {
      return base(step, StepStatus.skipped, 0, null)
    }
  }

  /** Factory for {@link ErrorDetail}. */
  export namespace ErrorDetail {
    /**
     * Build an {@link ErrorDetail} from a thrown value, the step input, and
     * optionally captured child-process output.
     */
    export function from(
      error: unknown,
      input: unknown = null,
      processOutput: string | null = null
    ): ErrorDetail {
      return {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
        processOutput,
        input: input ?? null
      }
    }
  }
}
