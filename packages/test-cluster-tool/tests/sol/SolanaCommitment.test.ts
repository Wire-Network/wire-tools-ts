import {
  DefaultSolanaCommitment,
  SolanaConfirmationStatus
} from "@wireio/test-cluster-tool/sol/SolanaCommitment"

describe("SolanaConfirmationStatus", () => {
  it("mirrors web3.js TransactionConfirmationStatus spellings", () => {
    expect(SolanaConfirmationStatus.Processed).toBe("processed")
    expect(SolanaConfirmationStatus.Confirmed).toBe("confirmed")
    expect(SolanaConfirmationStatus.Finalized).toBe("finalized")
  })
})

describe("DefaultSolanaCommitment", () => {
  it("stays in lock-step with SolanaConfirmationStatus.Confirmed", () => {
    expect(DefaultSolanaCommitment).toBe(
      SolanaConfirmationStatus.Confirmed.toString()
    )
  })
})
