import { PublicKey } from "@solana/web3.js"
import {
  LiqsolPdaSeed,
  PendingPayoutRequestIdBytes,
  pendingPayoutAddress
} from "@wireio/cluster-tool/tools/solana"

/** liqsol-core's declared program id — the id the vectors below were derived under. */
const LiqsolCoreProgramId = new PublicKey(
  "5nBtmutQLrRKBUxNfHJPDjiW5u8id6QM9Hhjg1D1g1XH"
)

describe("LiqsolPdaSeed", () => {
  describe("pendingPayoutAddress", () => {
    it("derives the relay's pending-desyndication PDA for known request ids", () => {
      // The vectors wire-sysio's relay test pins
      // (`pending_desyndication_pda_matches_the_program_derivation`, c32df20652):
      // the harness, the relay and the program must name the same account.
      // The multi-byte id pins the little-endian encoding.
      expect(pendingPayoutAddress(LiqsolCoreProgramId, 1n).toBase58()).toBe(
        "6nDs1ohHKjjBjDp9KD8BDvjjqs2ZEYeR3eTHyF7ZNA8T"
      )
      expect(pendingPayoutAddress(LiqsolCoreProgramId, 7n).toBase58()).toBe(
        "BV578hrPb772NQkcMxVUS55QFsJpZw9Xq9hAQXiJioJd"
      )
      expect(
        pendingPayoutAddress(LiqsolCoreProgramId, 0x0102030405060708n).toBase58()
      ).toBe("5K37mePygNUJ3W9nwD4fkFH9ehUxMVKNyseipwmMrfED")
    })

    it("spells the seed as the program's PENDING_PAYOUT_SEED over an 8-byte id", () => {
      expect(LiqsolPdaSeed.PendingDesyndication).toBe("pending_desyndication")
      expect(PendingPayoutRequestIdBytes).toBe(8)
    })

    it("refuses request id 0, which keys no PDA on chain", () => {
      expect(() => pendingPayoutAddress(LiqsolCoreProgramId, 0n)).toThrow(
        /not a positive u64/
      )
    })

    it("refuses an id past u64", () => {
      expect(() =>
        pendingPayoutAddress(LiqsolCoreProgramId, 1n << 64n)
      ).toThrow(/not a positive u64/)
    })
  })
})
