import { ResultSummary } from "../../results/index.js"
import type { RenderConfig, RenderInput } from "../RenderOptions.js"

/**
 * Summary lines (stats, state) appended by human-oriented formats — composed
 * from {@link ResultSummary} parts, so they read exactly like the CLI, TUI and
 * GUI summaries.
 */
export namespace resultSummary {
  /**
   * `rows a–b of total · scanned N · matched N · N µs server · N ms wall`.
   *
   * @param input - What is rendered.
   * @returns The stats line.
   */
  export function statsLine(input: RenderInput): string {
    const { execution } = input,
      { page, stats } = execution.result
    return ResultSummary.join([
      ResultSummary.rowsPart(page),
      ResultSummary.scannedPart(stats),
      ResultSummary.matchedPart(stats),
      ResultSummary.elapsedPart(execution)
    ])
  }

  /**
   * `block N · <block id> · <block time> · <read mode> · LIB N · synced`.
   *
   * @param input - What is rendered.
   * @returns The state line.
   */
  export function stateLine(input: RenderInput): string {
    const { state } = input.execution.result
    return ResultSummary.join([
      ResultSummary.blockPart(state),
      state.block_id,
      state.block_time,
      state.read_mode,
      ResultSummary.irreversiblePart(state),
      ResultSummary.syncedLabel(state)
    ])
  }

  /**
   * The configured summary lines.
   *
   * @param input - What is rendered.
   * @param config - Which lines.
   * @returns Lines (possibly empty).
   */
  export function lines(input: RenderInput, config: RenderConfig): string[] {
    return [...(config.showStats ? [statsLine(input)] : []), ...(config.showState ? [stateLine(input)] : [])]
  }
}
