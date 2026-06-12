import { matchesProtoEnum } from "@wireio/test-cluster-tool/util"
import { SystemContracts } from "@wireio/sdk-core"

/**
 * `matchesProtoEnum` must accept every spelling chain_plugin emits for an
 * enum table cell: the numeric value, the numeric value as a string, and
 * the proto-spelling string (which is the generated enum's member NAME).
 */
describe("matchesProtoEnum", () => {
  const Status = SystemContracts.SysioOpregOperatorstatus
  const Active = Status.OPERATOR_STATUS_ACTIVE

  it("matches the numeric representation", () => {
    expect(matchesProtoEnum(Active, Status, Active)).toBe(true)
  })

  it("matches the numeric-string representation", () => {
    expect(matchesProtoEnum(String(Active), Status, Active)).toBe(true)
  })

  it("matches the proto-spelling string representation", () => {
    expect(matchesProtoEnum("OPERATOR_STATUS_ACTIVE", Status, Active)).toBe(
      true
    )
  })

  it("rejects a different member in every representation", () => {
    const Warmup = Status.OPERATOR_STATUS_WARMUP
    expect(matchesProtoEnum(Warmup, Status, Active)).toBe(false)
    expect(matchesProtoEnum(String(Warmup), Status, Active)).toBe(false)
    expect(matchesProtoEnum("OPERATOR_STATUS_WARMUP", Status, Active)).toBe(
      false
    )
  })

  it("rejects null, undefined, and non-scalar cells", () => {
    expect(matchesProtoEnum(null, Status, Active)).toBe(false)
    expect(matchesProtoEnum(undefined, Status, Active)).toBe(false)
    expect(matchesProtoEnum({ status: Active }, Status, Active)).toBe(false)
  })

  it("works against a second generated enum (dispute status)", () => {
    const Dispute = SystemContracts.SysioChalgDisputestatus
    expect(
      matchesProtoEnum(
        "DISPUTE_STATUS_OPEN",
        Dispute,
        Dispute.DISPUTE_STATUS_OPEN
      )
    ).toBe(true)
    expect(
      matchesProtoEnum(
        Dispute.DISPUTE_STATUS_RESOLVED,
        Dispute,
        Dispute.DISPUTE_STATUS_OPEN
      )
    ).toBe(false)
  })
})
