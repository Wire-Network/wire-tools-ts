/**
 * Redaction of secret-bearing command lines at the RECORDING boundary.
 *
 * Every `StepExtraRecorder.record` payload is serialized verbatim into
 * `<cluster>/reports/cluster-build.{csv,md,html}` by the Report renderers, so a
 * command line captured with its secret intact publishes that secret to every
 * consumer of the Report — including CI artifacts. Mask at the ONE point the
 * argv becomes a record, never at the renderers (three of them) and never at
 * the call sites (dozens).
 */

/** Replaces a redacted value; a fixed marker so a report stays greppable. */
export const RedactedMarker = "<redacted>"

/**
 * Flags whose FOLLOWING argv entry is the secret itself —
 * `clio wallet import --private-key PVT_K1_…`, `wallet unlock --password …`.
 */
const SecretArgFlags: ReadonlySet<string> = new Set(["--private-key", "--password"])

/**
 * A secret embedded INSIDE a larger token rather than passed as its own arg —
 * `nodeop --signature-provider <pubkey>=KEY:PVT_K1_…`. The key runs to the end
 * of the token, so everything after `KEY:` is replaced.
 */
const InlineKeySpecPattern = /KEY:[^\s,"']+/g

/**
 * `argv` with every secret replaced by {@link RedactedMarker} — the form safe
 * to record, log, or render into a Report.
 *
 * Handles both shapes a secret takes on a command line: a value in the entry
 * AFTER a {@link SecretArgFlags} flag, and an inline `KEY:` spec segment. The
 * executable path and every non-secret argument are preserved verbatim, so the
 * record still says exactly what ran.
 *
 * @param argv - The full command line, executable first.
 * @returns A new array with secrets masked; the input is never mutated.
 */
export function maskSecretArgs(argv: readonly string[]): string[] {
  return argv.map((arg, index) =>
    index > 0 && SecretArgFlags.has(argv[index - 1])
      ? RedactedMarker
      : arg.replace(InlineKeySpecPattern, `KEY:${RedactedMarker}`)
  )
}
