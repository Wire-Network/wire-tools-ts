import { isSolanaProgramRuntimeFailure } from "@wireio/cluster-tool/flow"

describe("isSolanaProgramRuntimeFailure", () => {
  it.each([
    "ProgramFailedToComplete",
    "Program failed to complete",
    "Error processing Instruction 1: Program   failed to complete",
    "SBF program panicked"
  ])("recognizes %s", line => {
    expect(isSolanaProgramRuntimeFailure(line)).toBe(true)
  })

  it("does not classify an ordinary simulation error as terminal", () => {
    expect(
      isSolanaProgramRuntimeFailure(
        "Transaction simulation failed: account is already in use"
      )
    ).toBe(false)
  })
})
