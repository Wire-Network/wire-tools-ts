import { SysioContracts } from "@wireio/sdk-core"

/**
 * One `sysio.opreg::operators` row — a bootstrapped, ACTIVE operator with no
 * balances or history unless `overrides` says otherwise.
 *
 * @param account - The row's on-chain account.
 * @param type - The row's operator type (default BATCH).
 * @param overrides - Fields to replace (`is_bootstrapped`, `status`, …).
 * @returns The row.
 */
export function fixtureOperatorRow(
  account: string,
  type: SysioContracts.SysioOpregOperatortype = SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
  overrides: Partial<SysioContracts.SysioOpregOperatorEntryType> = {}
): SysioContracts.SysioOpregOperatorEntryType {
  return {
    account,
    type,
    status: SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
    is_bootstrapped: true,
    balances: [],
    registered_at: 0,
    available_at: 0,
    updated_at: 0,
    terminated_at: 0,
    status_reason: "",
    recent_actions: [],
    ...overrides
  }
}
