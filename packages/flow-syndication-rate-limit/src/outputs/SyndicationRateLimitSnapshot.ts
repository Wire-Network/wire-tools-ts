/** Exact accounting captured before the scenario operation. */
export interface SyndicationRateLimitSnapshot {
  /** Pre-operation balance. */
  readonly balance: bigint
  /** Pre-operation supply. */
  readonly supply: bigint
  /** Pre-operation sum. */
  readonly sum: bigint
  /** Pre-operation logs. */
  readonly logs: number
}
