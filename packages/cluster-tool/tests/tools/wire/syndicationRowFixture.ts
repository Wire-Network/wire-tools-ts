import { SysioContracts } from "@wireio/sdk-core"

/** Request id the fixture rows carry unless a test names one. */
export const FixtureRequestId = 7
/** Token code the fixture rows carry unless a test names one. */
export const FixtureTokenCode = "LIQSOL"
/** The timestamp a fixture request was created and bonded at. */
const FixtureTimestamp = "2026-09-30T00:00:00.000"
/** The zero timestamp of a request that was never held or resolved. */
const UnsetTimestamp = "1970-01-01T00:00:00.000"

/**
 * One complete `sysio.synd::envelopes` row.
 *
 * @param chainCode - The pair's chain.
 * @param tokenCode - The pair's token.
 * @param epochIndex - The envelope's epoch.
 * @param state - The envelope's state.
 * @param requestId - The request issued for it.
 * @param outcome - The request's outcome.
 * @return The row.
 */
export function syndEnvelopeRow(
  chainCode: string,
  tokenCode: string,
  epochIndex: number,
  state: SysioContracts.SysioSyndEnvelopeState,
  requestId: SysioContracts.SysioSyndEnvelopeRowType["request_id"] = FixtureRequestId,
  outcome: SysioContracts.SysioSyndRequestOutcome = SysioContracts.SysioSyndRequestOutcome.PENDING
): SysioContracts.SysioSyndEnvelopeRowType {
  return {
    chain_code: chainCode,
    token_code: tokenCode,
    epoch_index: epochIndex,
    digest: "00".repeat(32),
    synd_total: 5_000_000_000,
    yield_total: 0,
    item_count: 1,
    state,
    request_id: requestId,
    released: 0,
    burned: 0,
    outcome,
    forfeit: 0,
    bounty_returned: 0
  }
}

/**
 * One complete `sysio.bond::requests` row.
 *
 * @param covered - The request's covered amount.
 * @param bonded - The amount bonded so far.
 * @param state - The request's state.
 * @param requestId - The request's id.
 * @return The row.
 */
export function bondRequestRow(
  covered: SysioContracts.SysioBondRequestRowType["covered"],
  bonded: SysioContracts.SysioBondRequestRowType["bonded"],
  state: SysioContracts.SysioBondRequestRowType["state"],
  requestId: SysioContracts.SysioBondRequestRowType["id"] = FixtureRequestId
): SysioContracts.SysioBondRequestRowType {
  return {
    id: String(requestId),
    issuer: "sysio.synd",
    schema: "oppenvelope",
    statement: "",
    statement_digest: "00".repeat(32),
    token_code: FixtureTokenCode,
    covered,
    bonded,
    bounty: 0,
    window_sec: 60,
    state,
    created_at: FixtureTimestamp,
    bonded_at: FixtureTimestamp,
    hold_bond: 0,
    hold_beneficiary: "",
    held_at: UnsetTimestamp,
    resolved_at: UnsetTimestamp,
    resolved_index: "0",
    forfeit_pending: 0,
    outcome_acknowledged: false
  }
}

/**
 * One `sysio.bond::bonds` row, accruing no yield.
 *
 * @param requestId - The request bonded.
 * @param underwriter - The bonding account.
 * @param amount - The amount bonded.
 * @param paid - Whether the bond has been paid back.
 * @return The row.
 */
export function bondRow(
  requestId: SysioContracts.SysioBondBondRowType["request_id"],
  underwriter: SysioContracts.SysioBondBondRowType["underwriter"],
  amount: SysioContracts.SysioBondBondRowType["amount"],
  paid: SysioContracts.SysioBondBondRowType["paid"] = false
): SysioContracts.SysioBondBondRowType {
  return {
    request_id: requestId,
    underwriter,
    amount,
    yield: { index_checkpoint: "0", owed_wire: 0 },
    paid
  }
}
