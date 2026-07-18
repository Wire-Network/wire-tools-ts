import { promises as Fsp } from "node:fs"
import Path from "node:path"
import {
  ClusterConfigReportFormat,
  type ClusterConfigReport
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/shared"
import type { ReportRendererRegistry } from "./ReportRendererRegistry.js"
import { StepExtraRecorder as StepExtraRecorderTool } from "./tools/StepExtraRecorder.js"

const log = getLogger("Report")

/**
 * The complete run narrative — a TREE of phase groups and phases mirroring the
 * build's orchestration structure (Build → PhaseGroup → PhaseGroup/Phase →
 * Steps, nested to any depth). Built up as a ClusterBuild runs (each
 * `ClusterBuildPhaseGroup.run()` returns one {@link Report.Group} node, each
 * `ClusterBuildPhase.run()` one {@link Report.Phase} node), then rendered to
 * every configured {@link Report.Format}.
 *
 * `Report` is BOTH this class and a companion namespace (below) carrying the
 * report domain types, the phase builder, and the step/error factories.
 */
export class Report {
  private readonly nodeList: Report.Node[] = []

  /**
   * The run's display name — the flow scenario's name (`flow-…`), set by
   * `FlowCLI` before the build runs; null for unnamed runs (the
   * `wire-cluster-tool` CLI), where renderers fall back to
   * {@link Report.DefaultName}.
   */
  name: string | null = null

  /** The narrative tree's root nodes — internally mutable, externally read-only. */
  get nodes(): ReadonlyArray<Report.Node> {
    return this.nodeList
  }

  /**
   * Every {@link Report.Phase} in the tree, depth-first — the flat view for
   * consumers that only care about phase/step outcomes (counts, verdicts).
   */
  get phases(): ReadonlyArray<Report.Phase> {
    return this.nodeList.flatMap(node => Report.Node.phases(node))
  }

  /** True when every node in the tree succeeded. */
  get succeeded(): boolean {
    return this.nodeList.every(node => node.succeeded)
  }

  /** Append finished nodes (variadic, fluent). */
  push(...nodes: Report.Node[]): Report {
    this.nodeList.push(...nodes)
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
    format: ClusterConfigReportFormat,
    registry: ReportRendererRegistry
  ): Promise<void> {
    const Ctor = registry.get(format)
    const file = Path.join(config.path, `${config.basename}.${format}`)
    await Fsp.writeFile(file, new Ctor(this).render(), "utf8")
    log.info("Report written: %s", file)
  }
}

export namespace Report {
  /**
   * Per-step client-call capture (see `report/tools/StepExtraRecorder.ts`) —
   * re-exported here so consumers reach it as `Report.StepExtraRecorder`.
   */
  export import StepExtraRecorder = StepExtraRecorderTool

  /** Title fallback when the run has no {@link Report.name} (CLI runs). */
  export const DefaultName = "cluster-build"

  /** The Eastern-time zone the report timestamps render alongside UTC. */
  export const EasternTimeZone = "America/New_York"

  /** The run title: `<name>: SUCCESS|FAILED` (the renderers' heading text). */
  export function title(report: Report): string {
    return `${report.name ?? DefaultName}: ${report.succeeded ? "SUCCESS" : "FAILED"}`
  }

  /**
   * The report's generation timestamp in UTC and Eastern time —
   * `2026-07-03 19:52:08 UTC · 2026-07-03 15:52:08 EDT` — prepended to the
   * phases/steps/duration stats by the MD + HTML renderers.
   */
  export function timestampLine(at: Date = new Date()): string {
    const utc = at.toISOString().slice(0, 19).replace("T", " ")
    const eastern = new Intl.DateTimeFormat("en-CA", {
      timeZone: EasternTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short"
    })
      .format(at)
      .replace(",", "")
    return `${utc} UTC · ${eastern}`
  }

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

  /**
   * Output format — value matches the file extension. Aliases the ONE
   * declaration, `ClusterConfigReportFormat` (`@wireio/cluster-tool-shared`).
   */
  export import Format = ClusterConfigReportFormat

  /** Per-step outcome. */
  export enum StepStatus {
    ok = "ok",
    failed = "failed",
    skipped = "skipped"
  }

  /** Narrative tree node kinds. */
  export enum NodeKind {
    group = "group",
    phase = "phase"
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
    /**
     * Client-call capture for the step — every wire/clio/ethereum/solana
     * client action, transaction, and CLI invocation the step's runner
     * performed (payloads + command lines), recorded by
     * `StepExtraRecorder`. A plain, JSON-stringify-safe object; null when
     * the step made no recorded client calls.
     */
    extra: Record<string, unknown> | null
    error: ErrorDetail | null
  }

  /** A leaf narrative node: one phase of executed steps. */
  export interface Phase {
    kind: NodeKind.phase
    name: string
    description: string
    steps: ReadonlyArray<StepResult>
    succeeded: boolean
    durationMs: number
  }

  /** A branch narrative node: a phase group of phases and/or sub-groups. */
  export interface Group {
    kind: NodeKind.group
    name: string
    description: string
    children: ReadonlyArray<Node>
    succeeded: boolean
    durationMs: number
  }

  /** Any narrative tree node. */
  export type Node = Phase | Group

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

  /** Factory + derived readings over {@link Group} nodes. */
  export namespace Group {
    /**
     * Freeze a group node from its executed children — succeeded iff every
     * child succeeded (a sequential group that omitted children after a
     * failure is already failed via that failing child).
     */
    export function from(
      name: string,
      description: string,
      children: Node[],
      durationMs: number
    ): Group {
      return {
        kind: NodeKind.group,
        name,
        description,
        children,
        succeeded: children.every(child => child.succeeded),
        durationMs
      }
    }
  }

  /** Recursive readings over any {@link Node}. */
  export namespace Node {
    /** Type guard: the node is a {@link Group}. */
    export function isGroup(node: Node): node is Group {
      return node.kind === NodeKind.group
    }

    /** Type guard: the node is a {@link Phase}. */
    export function isPhase(node: Node): node is Phase {
      return node.kind === NodeKind.phase
    }

    /** Every phase under `node` (itself included when a phase), depth-first. */
    export function phases(node: Node): Phase[] {
      return isPhase(node)
        ? [node]
        : node.children.flatMap(child => phases(child))
    }

    /** Total executed-step count under `node`. */
    export function stepCount(node: Node): number {
      return phases(node).reduce(
        (total, phase) => total + phase.steps.length,
        0
      )
    }

    /** Total skipped-step count under `node`. */
    export function skippedCount(node: Node): number {
      return phases(node).reduce(
        (total, phase) => total + Phase.skippedCount(phase),
        0
      )
    }

    /** True when `node` (or any descendant) carries a failure or skip. */
    export function hasProblem(node: Node): boolean {
      return !node.succeeded || skippedCount(node) > 0
    }
  }

  /**
   * Caller-facing write target — the persisted `ClusterConfigReport` shape
   * (`@wireio/cluster-tool-shared`). `Format` enum values satisfy its
   * literal-union `formats` by identity, so construction sites keep using the
   * enum while the ONE declaration lives with the persisted config family.
   */
  export interface Config extends ClusterConfigReport {}

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
   * Created by `ClusterBuildPhase.run()`; one `push` per executed step.
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
        kind: NodeKind.phase,
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
      error: ErrorDetail | null,
      extra: Record<string, unknown> | null
    ): StepResult {
      return {
        name: step.name,
        description: step.description,
        actor: step.actor,
        status,
        startedAt: new Date(Date.now() - durationMs).toISOString(),
        durationMs,
        input: step.input ?? null,
        extra,
        error
      }
    }
    /** A successful step result. */
    export function ok(
      step: StepLike,
      durationMs: number,
      extra: Record<string, unknown> | null = null
    ): StepResult {
      return base(step, StepStatus.ok, durationMs, null, extra)
    }
    /** A failed step result (builds the ErrorDetail from `error` + the step input). */
    export function failed(
      step: StepLike,
      durationMs: number,
      error: unknown,
      extra: Record<string, unknown> | null = null
    ): StepResult {
      return base(
        step,
        StepStatus.failed,
        durationMs,
        ErrorDetail.from(error, step.input),
        extra
      )
    }
    /** A skipped step result (an earlier sibling failed → this never ran). */
    export function skipped(step: StepLike): StepResult {
      return base(step, StepStatus.skipped, 0, null, {
        calls: [
          {
            client: "harness",
            kind: "note",
            text: "skipped — an earlier sibling failed; the step never ran"
          }
        ]
      })
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
