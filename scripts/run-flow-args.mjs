/**
 * Return the exact child-flow argument tokens following the runner's first
 * literal `--` delimiter.
 *
 * @param {readonly string[]} rawArguments process arguments after the script.
 * @returns {string[]} unmodified child-flow tokens.
 */
export function forwardedFlowArguments(rawArguments) {
  const delimiterIndex = rawArguments.indexOf("--")
  return delimiterIndex < 0 ? [] : rawArguments.slice(delimiterIndex + 1)
}

/**
 * Build the `pnpm … test` suffix for child-flow arguments. Pnpm needs its own
 * delimiter, so exactly one is prepended when forwarded tokens exist.
 *
 * @param {readonly string[]} rawArguments process arguments after the script.
 * @returns {string[]} empty, or `["--", ...forwardedTokens]`.
 */
export function pnpmFlowArguments(rawArguments) {
  const forwarded = forwardedFlowArguments(rawArguments)
  return forwarded.length === 0 ? [] : ["--", ...forwarded]
}
