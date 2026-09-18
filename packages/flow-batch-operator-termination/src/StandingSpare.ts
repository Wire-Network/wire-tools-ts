import Assert from "node:assert"
import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"

/** Require a full, disjoint nine-seat schedule, regardless of spare count. */
export function assertCompleteSchedule(
  groups: readonly (readonly string[])[]
): void {
  Assert.equal(groups.length, Constants.BatchOperatorGroups, "schedule group count changed")
  const members = new Set<string>()
  for (const group of groups) {
    Assert.equal(group.length, Constants.OperatorsPerEpoch, "schedule contains a short group")
    for (const member of group) {
      Assert.ok(!members.has(member), `${member} is seated in more than one group`)
      members.add(member)
    }
  }
  Assert.equal(members.size, Constants.ScheduleSeatCount, "schedule window is not full")
}

/** Choose an ACTIVE operator outside a complete activated schedule window. */
export function assertStandingSpare(
  activeAccounts: ReadonlySet<string>,
  groups: readonly (readonly string[])[],
  expectedSpareCount: number
): string {
  assertCompleteSchedule(groups)
  const seated = groups.flat()
  Assert.ok(
    seated.every(account => activeAccounts.has(account)),
    "activated window contains an inactive member"
  )
  const spares = [...activeAccounts]
    .filter(account => !seated.includes(account))
    .sort()
  Assert.equal(
    spares.length,
    expectedSpareCount,
    "standing-spare pool changed before recovery"
  )
  Assert.ok(spares.length > 0, "no standing spare is available")
  return spares[0]
}
