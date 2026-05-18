import Assert from "node:assert"
import Fs from "node:fs"

import { ChainTokenAmount } from "@wireio/opp-typescript-models"
import type { UnderwriterCollateralEntry } from "@wireio/debugging-shared"

import { buildDefaultUnderwriterCollateral } from "./defaultUnderwriterCollateral.js"

/**
 * Project a parsed `ChainTokenAmount` proto message onto the primitive
 * `UnderwriterCollateralEntry` stored on `ClusterConfig`. The proto
 * model carries `chain: { kind, id }` and `amount: { kind, amount }`;
 * the primitive shape flattens both and stringifies the amount so the
 * config round-trips losslessly through JSON without losing bigint
 * precision.
 *
 * @param parsed Hydrated `ChainTokenAmount` message (from
 *   `ChainTokenAmount.fromJson` or `.fromBinary`).
 * @returns Flattened entry with primitive fields.
 */
function projectChainTokenAmount(
  parsed: ChainTokenAmount
): UnderwriterCollateralEntry {
  Assert.ok(
    parsed.chain,
    "ChainTokenAmount.chain is required"
  )
  Assert.ok(
    parsed.amount,
    "ChainTokenAmount.amount is required"
  )
  return {
    chain: parsed.chain.kind,
    chainId: parsed.chain.id,
    tokenKind: parsed.amount.kind,
    amount: String(parsed.amount.amount)
  }
}

/**
 * Parse a JSON value (already loaded from disk) into the canonical
 * length-`underwriterCount` per-underwriter shape stored on
 * `ClusterConfig.underwriterCollateral`. The input value may be in
 * either of two shapes per the spec at "Underwriter Collateral Config
 * for `test-cluster-tool`":
 *
 *   * **Uniform** — `Array<ChainTokenAmount>`. Applied to every
 *     underwriter. Fan-out-expanded to `underwriterCount` copies.
 *   * **Varied** — `Array<Array<ChainTokenAmount>>`. Outer array length
 *     MUST equal `underwriterCount`; otherwise this throws.
 *
 * Both shapes are parsed via `@protobuf-ts/runtime` JSON serdes against
 * the proto-generated `ChainTokenAmount` model, so callers get full
 * field-level validation (unknown fields → error, missing required
 * enum → error, etc.) without the harness re-implementing the schema.
 *
 * @param json             Already-parsed JSON value (`JSON.parse(fileContents)`).
 * @param underwriterCount Number of underwriters in the cluster — used
 *                         to validate varied input and to fan out
 *                         uniform input.
 * @returns Length-`underwriterCount` array, one entry-list per underwriter.
 * @throws If the input is neither uniform nor varied shape, OR if a
 *   varied input's outer length does not match `underwriterCount`, OR
 *   if any inner `ChainTokenAmount` fails proto-level validation.
 */
export function parseUnderwriterCollateralJson(
  json: unknown,
  underwriterCount: number
): UnderwriterCollateralEntry[][] {
  Assert.ok(
    Array.isArray(json),
    "underwriter collateral JSON must be an array"
  )
  Assert.ok(
    underwriterCount > 0,
    `underwriterCount must be positive, got ${underwriterCount}`
  )

  const items = json as unknown[]
  if (items.length === 0) {
    // Treat an empty array as "use defaults" so an operator that wants
    // to drop in an empty file as a placeholder gets the same shape
    // they would have got with no flag at all.
    return Array.from({ length: underwriterCount }, () =>
      buildDefaultUnderwriterCollateral()
    )
  }

  // Uniform vs varied detection: the inner element of a varied input
  // is itself an array; the inner element of a uniform input is an
  // object literal. We trust the first element shape to discriminate
  // (a mixed-shape input is malformed).
  const head = items[0]
  const isVaried = Array.isArray(head)

  if (isVaried) {
    Assert.ok(
      items.length === underwriterCount,
      `underwriter collateral (varied shape): outer array length ${items.length} ` +
        `must equal --underwriters (${underwriterCount})`
    )
    return items.map((entry, idx) => {
      Assert.ok(
        Array.isArray(entry),
        `underwriter collateral (varied shape): entry ${idx} must be an array`
      )
      return entry.map(raw =>
        projectChainTokenAmount(ChainTokenAmount.fromJson(
          raw as Parameters<typeof ChainTokenAmount.fromJson>[0]
        ))
      )
    })
  }

  // Uniform shape: parse once, fan out to every underwriter.
  const uniform = items.map(raw =>
    projectChainTokenAmount(ChainTokenAmount.fromJson(
          raw as Parameters<typeof ChainTokenAmount.fromJson>[0]
        ))
  )
  return Array.from({ length: underwriterCount }, () => uniform.slice())
}

/**
 * Resolve the final `ClusterConfig.underwriterCollateral` value from
 * the CLI surface. If a file path is supplied, it's read + parsed via
 * `parseUnderwriterCollateralJson`. Otherwise the defaults from
 * `buildDefaultUnderwriterCollateral` are fanned out to every
 * underwriter.
 *
 * @param filePath          Optional path to the JSON config file.
 *                          When `undefined`, defaults are used.
 * @param underwriterCount  Number of underwriters in the cluster.
 * @returns Length-`underwriterCount` array, one entry-list per underwriter.
 * @example
 *   // No file → defaults (1000 base units of WIRE/ETH/SOL per underwriter).
 *   loadUnderwriterCollateral(undefined, 3)
 *   // With file → parsed per the file's shape (uniform or varied).
 *   loadUnderwriterCollateral("/path/to/file.json", 3)
 */
export function loadUnderwriterCollateral(
  filePath: string | undefined,
  underwriterCount: number
): UnderwriterCollateralEntry[][] {
  Assert.ok(
    underwriterCount > 0,
    `underwriterCount must be positive, got ${underwriterCount}`
  )
  if (!filePath) {
    return Array.from({ length: underwriterCount }, () =>
      buildDefaultUnderwriterCollateral()
    )
  }
  Assert.ok(
    Fs.existsSync(filePath),
    `--underwriter-collateral-json-file: ${filePath} does not exist`
  )
  const raw = Fs.readFileSync(filePath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `--underwriter-collateral-json-file: ${filePath} is not valid JSON: ${
        (err as Error).message
      }`
    )
  }
  return parseUnderwriterCollateralJson(parsed, underwriterCount)
}
