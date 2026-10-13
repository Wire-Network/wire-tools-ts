import { match } from "ts-pattern"

import { SchemaCodec } from "@wireio/cluster-tool-shared"

import { LogicalType, type QueryColumn } from "../protocol/index.js"
import { CellFormatter } from "./CellFormatter.js"
import type { AssetCell, CellValue } from "./CellValue.js"

/** What an inspected value is. */
export enum InspectedValueKind {
  null = "null",
  scalar = "scalar",
  json = "json",
  asset = "asset",
  hex = "hex",
  time = "time"
}

/** One labelled part of an inspected value. */
export interface InspectedField {
  /** Part name. */
  label: string
  /** Part text. */
  value: string
}

/** Structured view of one cell (GUI value inspector, TUI inspector modal). */
export interface InspectedValue {
  /** What it is. */
  kind: InspectedValueKind
  /** Column name. */
  column: string
  /** Column logical type. */
  logicalType: LogicalType
  /** Full display text (pretty JSON for json cells). */
  display: string
  /** Labelled parts (asset breakdown, raw + decoded hex, ISO + epoch µs, JSON members). */
  fields: InspectedField[]
  /** The raw cell. */
  raw: CellValue
}

/** Engine timestamp text: (expanded) year, date, time, up to 6 fraction digits. */
const TimestampPattern = /^([+-]?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z?$/
/** Fraction digits of a microsecond timestamp. */
const MicrosecondDigits = 6
/** Microseconds per millisecond. */
const MicrosPerMilli = 1000n

/** Cell → structured view. */
export namespace ValueInspector {
  /** Field labels of an inspected value. */
  export enum FieldLabel {
    raw = "raw",
    decoded = "decoded",
    iso = "iso",
    epochMicros = "epochMicros",
    amount = "amount",
    symbol = "symbol",
    precision = "precision",
    contract = "contract"
  }

  /**
   * Inspect one cell.
   *
   * @param column - The column.
   * @param value - The cell.
   * @returns The structured view.
   */
  export function inspect(column: QueryColumn, value: CellValue): InspectedValue {
    const base = {
      column: column.name,
      logicalType: column.logical_type,
      raw: value
    }
    if (value === null) {
      return { ...base, kind: InspectedValueKind.null, display: CellFormatter.DefaultNullText, fields: [] }
    }
    const display = CellFormatter.format(column, value)
    return match(column.logical_type)
      .with(LogicalType.asset, LogicalType.extended_asset, () => ({
        ...base,
        kind: InspectedValueKind.asset,
        display,
        fields: assetFields(CellFormatter.assertAsset(column, value))
      }))
      .with(LogicalType.json, () => ({
        ...base,
        kind: InspectedValueKind.json,
        display: JSON.stringify(value, null, SchemaCodec.SerializeIndent),
        fields: jsonFields(value)
      }))
      .with(LogicalType.ieee_hex, () => ({
        ...base,
        kind: InspectedValueKind.hex,
        display,
        fields: [
          { label: FieldLabel.raw, value: CellFormatter.canonical(column, value) },
          { label: FieldLabel.decoded, value: display }
        ]
      }))
      .with(LogicalType.time, () => {
        const micros = epochMicros(value as string)
        return {
          ...base,
          kind: InspectedValueKind.time,
          display,
          fields: [
            { label: FieldLabel.iso, value: display },
            ...(micros == null ? [] : [{ label: FieldLabel.epochMicros, value: micros }])
          ]
        }
      })
      .otherwise(() => ({ ...base, kind: InspectedValueKind.scalar, display, fields: [] }))
  }

  /**
   * Microseconds since the Unix epoch of an engine timestamp (UTC), or null when unparsable.
   *
   * @param text - Engine timestamp text.
   * @returns Decimal-string microseconds.
   */
  export function epochMicros(text: string): string {
    const parts = TimestampPattern.exec(text)
    if (parts == null) return null
    const [, year, month, day, hour, minute, second, fraction = ""] = parts,
      date = new Date(0)
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
    date.setUTCHours(Number(hour), Number(minute), Number(second), 0)
    return (BigInt(date.getTime()) * MicrosPerMilli + BigInt(fraction.padEnd(MicrosecondDigits, "0"))).toString()
  }

  /** Asset breakdown. */
  function assetFields(asset: AssetCell): InspectedField[] {
    return [
      { label: FieldLabel.amount, value: asset.amount },
      { label: FieldLabel.symbol, value: asset.symbol },
      { label: FieldLabel.precision, value: asset.precision },
      ...(asset.contract == null ? [] : [{ label: FieldLabel.contract, value: asset.contract }])
    ]
  }

  /** Top-level members of a JSON container (empty for scalars). */
  function jsonFields(value: CellValue): InspectedField[] {
    return value !== null && typeof value === "object"
      ? Object.entries(value).map(([label, member]) => ({ label, value: JSON.stringify(member) }))
      : []
  }
}
