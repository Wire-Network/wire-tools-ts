/** Exact accounting captured before the scenario operation. */
export interface SyndicationUnderwritingSnapshot {
  /** Pre-operation holder. */
  readonly holder: bigint
  /** Pre-operation bonder. */
  readonly bonder: bigint
  /** Pre-operation fees. */
  readonly fees: bigint
}
