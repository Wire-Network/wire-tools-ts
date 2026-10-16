import { defaults, identity } from "lodash"
import { match, P } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import {
  LogicalType,
  QueryResultPatterns,
  type QueryColumn
} from "../protocol/index.js"
import { CellAlignment } from "./CellAlignment.js"
import { AssetCellSchema, type AssetCell, type CellValue } from "./CellValue.js"

/** Display (tables/grid) vs canonical (CSV/TSV/markdown) cell text. */
export enum CellFormatMode {
  display = "display",
  canonical = "canonical"
}

/** Cell formatting options (all optional). */
export interface CellFormatOptions {
  /** Display escapes control characters and decodes floats; canonical is lossless text. */
  mode?: CellFormatMode
  /** Text of a NULL cell. */
  nullText?: string
}

/** Resolved cell formatting options. */
export interface CellFormatConfig extends Required<CellFormatOptions> {}

/**
 * Defaults for {@link CellFormatOptions}.
 *
 * @returns The default options.
 */
export function createCellFormatDefaultOptions(): Partial<CellFormatOptions> {
  return { mode: CellFormatMode.display, nullText: CellFormatter.DefaultNullText }
}

/** First Unicode "control picture" (␀); C0 code c renders as ControlPictureBase + c. */
const ControlPictureBase = 0x2400
/** Last C0 control code. */
const LastC0Control = 0x1f
/** DEL and its control picture. */
const DeleteCode = 0x7f
/** Control picture of DEL (␡). */
const DeletePicture = "␡"
/** Hex digits per byte. */
const HexDigitsPerByte = 2
/** Radix of hex text. */
const HexRadix = 16
/** Byte widths of the IEEE floats the engine projects. */
enum IeeeWidth {
  single = 4,
  double = 8
}
/** `0x` prefix of an ieee_hex cell. */
const HexPrefix = "0x"
/** Asset fraction separator. */
const DecimalPoint = "."
/** Separator between an extended asset and its contract. */
const ContractSeparator = "@"

/** The sort key of an `ieee_hex` cell: its text and its decoded float (null when undecodable). */
export interface IeeeHexSortKey {
  /** The `0x…` text. */
  hex: string
  /** The decoded float, or null for a width that does not decode. */
  decoded: number
}

/** A cell's comparable key (see {@link CellFormatter.sortKey}). */
export type CellSortKey = null | bigint | boolean | string | AssetCell | IeeeHexSortKey

/** ONE facade formatting / aligning / comparing cells by logical type. */
export namespace CellFormatter {
  /** Default text of a NULL cell. */
  export const DefaultNullText = "NULL"

  /**
   * Format one cell by its column's logical type; asserts the cell matches the
   * column encoding (deep check).
   *
   * @param column - The column.
   * @param value - The cell.
   * @param options - Mode and null text.
   * @returns The cell text.
   * @throws NestedError when the cell does not match the column's encoding.
   */
  export function format(
    column: QueryColumn,
    value: CellValue,
    options: CellFormatOptions = {}
  ): string {
    const config = defaults({ ...options }, createCellFormatDefaultOptions()) as CellFormatConfig
    if (value === null) return config.nullText
    return match(column.logical_type)
      .with(LogicalType.integer, () => formatInteger(column, value))
      .with(LogicalType.decimal, () => formatDecimal(column, value))
      .with(LogicalType.boolean, () => formatBoolean(column, value))
      .with(LogicalType.text, LogicalType.enumeration, LogicalType.time, () =>
        formatText(column, value, config)
      )
      .with(LogicalType.asset, LogicalType.extended_asset, () => formatAsset(column, value))
      .with(LogicalType.json, () => formatJson(value))
      .with(LogicalType.ieee_hex, () => formatIeeeHex(column, value, config))
      .exhaustive()
  }

  /**
   * The canonical (lossless, unescaped) text of a cell — what CSV / TSV /
   * Markdown / HTML / XML and copied selections write.
   *
   * @param column - The column.
   * @param value - The cell.
   * @returns The canonical text (`NULL` for a null cell — formats with their own NULL spelling check null first).
   */
  export function canonical(column: QueryColumn, value: CellValue): string {
    return format(column, value, { mode: CellFormatMode.canonical })
  }

  /**
   * Case-insensitive "display text contains" — the ONE match used by column
   * filters and find-in-results.
   *
   * @param column - The column.
   * @param value - The cell.
   * @param text - The text to find (any case).
   * @returns Whether the cell's display text contains `text`.
   */
  export function containsText(column: QueryColumn, value: CellValue, text: string): boolean {
    return format(column, value).toLowerCase().includes(text.toLowerCase())
  }

  /**
   * Horizontal alignment: numbers and assets right, everything else left.
   *
   * @param column - The column.
   * @returns The alignment.
   */
  export function alignment(column: QueryColumn): CellAlignment {
    return match(column.logical_type)
      .with(
        LogicalType.integer,
        LogicalType.decimal,
        LogicalType.asset,
        LogicalType.extended_asset,
        () => CellAlignment.right
      )
      .otherwise(() => CellAlignment.left)
  }

  /**
   * Typed comparator: BigInt integers, exact decimal-string compare, asset by
   * amount within symbol (symbol first), `ieee_hex` by decoded value (raw text
   * when a side is undecodable or NaN), NULL last.
   *
   * @param column - The column.
   * @param left - Left cell.
   * @param right - Right cell.
   * @returns Negative, zero or positive.
   */
  export function compare(column: QueryColumn, left: CellValue, right: CellValue): number {
    return compareSortKeys(column, sortKey(column, left), sortKey(column, right))
  }

  /**
   * The comparable key of one cell — validated and decoded ONCE, so a sort
   * computes it per row rather than per comparison: a bigint for integers, the
   * decimal text for decimals, the boolean, the asset, the hex plus its decoded
   * float, or the canonical text; null for a NULL cell.
   *
   * @param column - The column.
   * @param value - The cell.
   * @returns The key (compare keys of one column with {@link compareSortKeys}).
   * @throws NestedError when the cell does not match the column's encoding.
   */
  export function sortKey(column: QueryColumn, value: CellValue): CellSortKey {
    if (value === null) return null
    return match<LogicalType, CellSortKey>(column.logical_type)
      .with(LogicalType.integer, () => BigInt(formatInteger(column, value)))
      .with(LogicalType.decimal, () => formatDecimal(column, value))
      .with(LogicalType.boolean, () => formatBoolean(column, value) === String(true))
      .with(LogicalType.asset, LogicalType.extended_asset, () => assertAsset(column, value))
      .with(LogicalType.ieee_hex, () => {
        const hex = formatIeeeHexText(column, value)
        return { hex, decoded: decodeIeeeHex(hex) }
      })
      .otherwise(() => canonical(column, value))
  }

  /**
   * Compare two keys of the same column (from {@link sortKey}); NULL last.
   *
   * @param column - The column the keys belong to.
   * @param left - Left key.
   * @param right - Right key.
   * @returns Negative, zero or positive.
   */
  export function compareSortKeys(column: QueryColumn, left: CellSortKey, right: CellSortKey): number {
    if (left === null || right === null) return nullOrder(left, right)
    return match(column.logical_type)
      .with(LogicalType.integer, () => sign((left as bigint) - (right as bigint)))
      .with(LogicalType.decimal, () => compareDecimal(left as string, right as string))
      .with(LogicalType.boolean, () => Number(left) - Number(right))
      .with(LogicalType.asset, LogicalType.extended_asset, () => compareAsset(left as AssetCell, right as AssetCell))
      .with(LogicalType.ieee_hex, () => compareIeeeHex(left as IeeeHexSortKey, right as IeeeHexSortKey))
      .otherwise(() => compareText(left as string, right as string))
  }

  /**
   * Exact comparison of two signed decimal strings (no floats).
   *
   * @param left - Decimal text.
   * @param right - Decimal text.
   * @returns Negative, zero or positive.
   */
  export function compareDecimal(left: string, right: string): number {
    const [leftInteger, leftFraction = ""] = left.split(DecimalPoint),
      [rightInteger, rightFraction = ""] = right.split(DecimalPoint),
      scale = Math.max(leftFraction.length, rightFraction.length)
    return sign(
      BigInt(leftInteger + leftFraction.padEnd(scale, "0")) -
        BigInt(rightInteger + rightFraction.padEnd(scale, "0"))
    )
  }

  /**
   * Render control characters as visible control pictures (`\n` → `␊`).
   *
   * @param text - Raw text.
   * @returns Escaped text.
   */
  export function escapeControlCharacters(text: string): string {
    return Array.from(text)
      .map(character => {
        const code = character.charCodeAt(0)
        return code === DeleteCode
          ? DeletePicture
          : code <= LastC0Control
            ? String.fromCharCode(ControlPictureBase + code)
            : character
      })
      .join("")
  }

  /**
   * Right-pad an asset amount's fraction with zeros to `precision` digits
   * (string math; the amount is already scaled — no decimal point moves).
   *
   * @param amount - Signed decimal amount, possibly with fewer fraction digits.
   * @param precision - Fraction digits.
   * @returns The amount with at least `precision` fraction digits (more are kept, never truncated).
   */
  export function padAssetFraction(amount: string, precision: number): string {
    const [integer, fraction = ""] = amount.split(DecimalPoint),
      padded = fraction.padEnd(precision, "0")
    return padded.length === 0 ? integer : `${integer}${DecimalPoint}${padded}`
  }

  /**
   * Decode an `ieee_hex` cell (little-endian float32/float64); null for other widths.
   *
   * @param hex - `0x…` text.
   * @returns The number, if decodable.
   */
  export function decodeIeeeHex(hex: string): number {
    const bytes = hex
        .slice(HexPrefix.length)
        .match(new RegExp(`.{${HexDigitsPerByte}}`, "g"))
        .map(pair => parseInt(pair, HexRadix)),
      view = new DataView(Uint8Array.from(bytes).buffer)
    return match(bytes.length)
      .with(IeeeWidth.single, () => view.getFloat32(0, true))
      .with(IeeeWidth.double, () => view.getFloat64(0, true))
      .otherwise(() => null)
  }

  /** NULL sorts last. */
  function nullOrder(left: CellSortKey, right: CellSortKey): number {
    return left === right ? 0 : left === null ? 1 : -1
  }

  /** Clamp a bigint/number difference to -1 / 0 / 1. */
  function sign(difference: bigint | number): number {
    return difference > 0 ? 1 : difference < 0 ? -1 : 0
  }

  /** Code-unit order (deterministic, locale-independent). */
  function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
  }

  /** ieee_hex: by decoded value when both sides decode to numbers, else by canonical text. */
  function compareIeeeHex(left: IeeeHexSortKey, right: IeeeHexSortKey): number {
    const comparable = [left.decoded, right.decoded].every(decoded => decoded != null && !Number.isNaN(decoded))
    return comparable ? sign(left.decoded - right.decoded) : compareText(left.hex, right.hex)
  }

  /** Assets: by symbol, then by amount. */
  function compareAsset(left: AssetCell, right: AssetCell): number {
    return left.symbol === right.symbol
      ? compareDecimal(left.amount, right.amount)
      : compareText(left.symbol, right.symbol)
  }

  /** Throw the encoding-mismatch error. */
  function mismatch(column: QueryColumn, value: CellValue): never {
    throw new NestedError(
      `cell of column ${column.name} does not match its ${column.logical_type} encoding`,
      { context: { column: column.name, logicalType: column.logical_type, encoding: column.encoding, value } }
    )
  }

  /** integer: a signed decimal string without a fraction. */
  function formatInteger(column: QueryColumn, value: CellValue): string {
    return match<unknown, string>(value)
      .with(P.string.regex(QueryResultPatterns.SignedInteger), identity)
      .otherwise(() => mismatch(column, value))
  }

  /** decimal: a signed decimal string. */
  function formatDecimal(column: QueryColumn, value: CellValue): string {
    return match<unknown, string>(value)
      .with(P.string.regex(QueryResultPatterns.SignedDecimal), identity)
      .otherwise(() => mismatch(column, value))
  }

  /** boolean: a JSON boolean. */
  function formatBoolean(column: QueryColumn, value: CellValue): string {
    return match<unknown, string>(value)
      .with(P.boolean, flag => String(flag))
      .otherwise(() => mismatch(column, value))
  }

  /** text / enumeration / time: a string; display escapes control characters. */
  function formatText(column: QueryColumn, value: CellValue, config: CellFormatConfig): string {
    return match<unknown, string>(value)
      .with(P.string, text =>
        config.mode === CellFormatMode.display ? escapeControlCharacters(text) : text
      )
      .otherwise(() => mismatch(column, value))
  }

  /**
   * Assert an asset cell's shape (`asset_object`: decimal amount, symbol, precision, optional contract).
   *
   * @param column - The column (for the error).
   * @param value - The cell.
   * @returns The cell as an asset.
   * @throws NestedError when the cell is not an asset object.
   */
  export function assertAsset(column: QueryColumn, value: CellValue): AssetCell {
    const parsed = AssetCellSchema.safeParse(value)
    return parsed.success ? parsed.data : mismatch(column, value)
  }

  /** asset / extended_asset: `1.2500 SYS` / `1.2500 SYS@contract`. */
  function formatAsset(column: QueryColumn, value: CellValue): string {
    const asset = assertAsset(column, value),
      quantity = `${padAssetFraction(asset.amount, Number(asset.precision))} ${asset.symbol}`
    if (column.logical_type === LogicalType.extended_asset && asset.contract == null) {
      mismatch(column, value)
    }
    return asset.contract == null ? quantity : `${quantity}${ContractSeparator}${asset.contract}`
  }

  /** json: compact JSON. */
  function formatJson(value: CellValue): string {
    return JSON.stringify(value)
  }

  /** ieee_hex: the `0x…` text (asserting the encoding). */
  function formatIeeeHexText(column: QueryColumn, value: CellValue): string {
    return match<unknown, string>(value)
      .with(P.string.regex(QueryResultPatterns.IeeeHex), identity)
      .otherwise(() => mismatch(column, value))
  }

  /** ieee_hex: canonical hex; display decodes the float. */
  function formatIeeeHex(column: QueryColumn, value: CellValue, config: CellFormatConfig): string {
    const hex = formatIeeeHexText(column, value)
    if (config.mode === CellFormatMode.canonical) return hex
    const decoded = decodeIeeeHex(hex)
    return decoded == null ? hex : String(decoded)
  }
}
