import { CellAlignment, CellFormatter, DisplayWidth, type CellValue } from "../../values/index.js"
import type { QueryColumn } from "../../protocol/index.js"
import { OutputFormat } from "../OutputFormat.js"
import { CellWidthMode, type RenderConfig, type RenderInput, type ResultRendererBackend } from "../RenderOptions.js"
import { resultSummary } from "../common/resultSummary.js"
import { textLines } from "../common/textLines.js"

/** Box-drawing characters. */
namespace Box {
  export const Horizontal = "─"
  export const Vertical = "│"
  export const TopLeft = "┌"
  export const TopJoin = "┬"
  export const TopRight = "┐"
  export const MiddleLeft = "├"
  export const MiddleJoin = "┼"
  export const MiddleRight = "┤"
  export const BottomLeft = "└"
  export const BottomJoin = "┴"
  export const BottomRight = "┘"
}

/** ANSI styles. */
namespace Ansi {
  export const Bold = "\u001b[1m"
  export const Dim = "\u001b[2m"
  export const Reset = "\u001b[0m"
}

/** Ellipsis marking a truncated cell. */
const Ellipsis = "…"
/** Plain-text file extension of the table format. */
const TableExtension = "txt"
/** Narrowest column (display columns). */
const MinimumColumnWidth = 1

/** Accumulator of {@link truncate}: the kept characters, their width, and whether one no longer fit. */
interface TruncationState {
  kept: string
  width: number
  stopped: boolean
}

/** One laid-out cell: plain text (measured) plus its style. */
interface TableCell {
  text: string
  style: string
}

/**
 * Truncate `text` to `maxWidth` display columns (ellipsis included): keep the
 * longest PREFIX that fits — the first character that does not fit ends the
 * prefix, so a narrow character after a wide one is never kept.
 */
function truncate(text: string, maxWidth: number): string {
  if (DisplayWidth.of(text) <= maxWidth) return text
  const budget = maxWidth - DisplayWidth.of(Ellipsis),
    { kept } = Array.from(text).reduce<TruncationState>(
      (state, character) => {
        if (state.stopped) return state
        const width = state.width + DisplayWidth.of(character)
        return width <= budget ? { kept: `${state.kept}${character}`, width, stopped: false } : { ...state, stopped: true }
      },
      { kept: "", width: 0, stopped: false }
    )
  return `${kept}${Ellipsis}`
}

/** Pad to `width` display columns by alignment. */
function pad(text: string, width: number, alignment: CellAlignment): string {
  const fill = " ".repeat(Math.max(0, width - DisplayWidth.of(text)))
  return alignment === CellAlignment.right ? `${fill}${text}` : `${text}${fill}`
}

/** A styled cell (styles only when color is on). */
function styled(cell: TableCell, padded: string, color: boolean): string {
  return color && cell.style.length > 0 ? `${cell.style}${padded}${Ansi.Reset}` : padded
}

/** Data cell of a column. */
function dataCell(column: QueryColumn, value: CellValue, config: RenderConfig): TableCell {
  const text = CellFormatter.format(column, value)
  return {
    text: config.cellWidthMode === CellWidthMode.truncated ? truncate(text, config.maxCellWidth) : text,
    style: value === null ? Ansi.Dim : ""
  }
}

/** Box-drawn table with display-width alignment; summary lines follow when enabled. */
export const TableResultRenderer: ResultRendererBackend = {
  format: OutputFormat.table,
  fileExtension: TableExtension,
  render(input: RenderInput, config: RenderConfig): string {
    const { columns } = input.view,
      headerCells: TableCell[] = columns.map(column => ({
        text: config.cellWidthMode === CellWidthMode.truncated ? truncate(column.name, config.maxCellWidth) : column.name,
        style: Ansi.Bold
      })),
      body = input.view.rows(input.range).map(row => columns.map(column => dataCell(column, row[column.name], config))),
      widths = columns.map((_column, index) =>
        [...(config.header ? [headerCells[index]] : []), ...body.map(cells => cells[index])].reduce(
          (widest, cell) => Math.max(widest, DisplayWidth.of(cell.text)),
          MinimumColumnWidth
        )
      ),
      rule = (left: string, join: string, right: string) =>
        `${left}${widths.map(width => Box.Horizontal.repeat(width + 2)).join(join)}${right}`,
      line = (cells: TableCell[], alignments: CellAlignment[]) =>
        `${Box.Vertical}${cells
          .map((cell, index) => ` ${styled(cell, pad(cell.text, widths[index], alignments[index]), config.color)} `)
          .join(Box.Vertical)}${Box.Vertical}`,
      dataAlignments = columns.map(column => CellFormatter.alignment(column)),
      headerAlignments = columns.map(() => CellAlignment.left),
      lines = [
        rule(Box.TopLeft, Box.TopJoin, Box.TopRight),
        ...(config.header ? [line(headerCells, headerAlignments), rule(Box.MiddleLeft, Box.MiddleJoin, Box.MiddleRight)] : []),
        ...body.map(cells => line(cells, dataAlignments)),
        rule(Box.BottomLeft, Box.BottomJoin, Box.BottomRight),
        ...resultSummary.lines(input, config)
      ]
    return textLines.render(lines)
  }
}
