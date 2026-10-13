/** Exact accounting captured before the scenario operation. */
export interface SyndicationRateLimitSnapshot {
  /** Pre-operation balance. */
  readonly balance: bigint
  /** Pre-operation supply. */
  readonly supply: bigint
  /** Number of outstanding returns before the operation. */
  readonly returns: number
}
