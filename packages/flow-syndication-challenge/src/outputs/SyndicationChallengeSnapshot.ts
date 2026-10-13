/** Exact accounting captured before the scenario operation. */
export interface SyndicationChallengeSnapshot {
  /** Pre-operation supply. */
  readonly supply: bigint
  /** Pre-operation holder. */
  readonly holder: bigint
  /** Pre-operation bonder. */
  readonly bonder: bigint
  /** Pre-operation fees. */
  readonly fees: bigint
  /** Pre-operation challenger. */
  readonly challenger: bigint
}
