import type {
  RunEvidenceDecimal,
  RunEvidencePhaseWindow
} from "./runEvidenceTypes.js"

const NonNegativeDecimalPattern = /^(0|[1-9][0-9]*)$/

/** Inputs required to construct one schema-valid phase observation window. */
export type OppPhaseWindowInput = {
  readonly startedAtMs: RunEvidenceDecimal
  readonly endedAtMs: RunEvidenceDecimal
  readonly epochStart: number
  readonly epochEnd: number
}

/**
 * Parse caller-owned phase bounds before observation allocation or filesystem I/O.
 *
 * @param input Decimal timestamps and inclusive source epoch bounds.
 * @returns The exact caller window encoded for schema-v1 evidence.
 */
export function parseOppPhaseWindow(
  input: OppPhaseWindowInput
): RunEvidencePhaseWindow {
  if (
    !Number.isSafeInteger(input.epochStart) ||
    input.epochStart < 0 ||
    !Number.isSafeInteger(input.epochEnd) ||
    input.epochEnd < 0
  )
    throw new TypeError(
      "OPP phase epoch bounds must be nonnegative safe integers"
    )
  if (input.epochStart > input.epochEnd)
    throw new TypeError("OPP phase epoch bounds must be ordered")
  if (
    !NonNegativeDecimalPattern.test(input.startedAtMs) ||
    !NonNegativeDecimalPattern.test(input.endedAtMs)
  )
    throw new TypeError("OPP phase timestamps must be nonnegative decimals")
  if (BigInt(input.startedAtMs) > BigInt(input.endedAtMs))
    throw new TypeError("OPP phase timestamps must be ordered")
  return {
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    epochStart: `${BigInt(input.epochStart)}`,
    epochEnd: `${BigInt(input.epochEnd)}`
  }
}
