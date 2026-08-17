/** Typed failure raised when unknown input violates the telemetry-health contract. */
export class OppEnvelopeTelemetryHealthParseError extends Error {
  /** Stable serialized error name. */
  readonly name = "OppEnvelopeTelemetryHealthParseError"
  /** Contract path containing the invalid value. */
  readonly path: string
  /** Structural or invariant violation at the contract path. */
  readonly problem: string

  /**
   * Create a telemetry-health parse failure.
   *
   * @param path Contract path containing the invalid value.
   * @param problem Structural or invariant violation at that path.
   */
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`)
    this.path = path
    this.problem = problem
  }
}
