import Assert from "node:assert"
import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"

/** Select an original peer whose absence makes the replacement necessary for quorum. */
export function assertReplacementQuorumPeer(
  groups: readonly (readonly string[])[],
  replacements: readonly string[],
  replacement: string
): string {
  Assert.equal(replacements.length, Constants.RecoveryOperatorLabels.length)
  Assert.equal(new Set(replacements).size, replacements.length)
  Assert.ok(replacements.includes(replacement), "unknown replacement")
  const group = groups.find(members => members.includes(replacement))
  Assert.ok(group != null, `${replacement} is not seated`)
  Assert.equal(group.length, Constants.OperatorsPerEpoch)
  Assert.equal(new Set(group).size, group.length)
  const peer = group.find(account => !replacements.includes(account))
  Assert.ok(peer != null, "replacement duty has no original peer")
  return peer
}
