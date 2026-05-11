import { WIREClient } from "@wireio/test-cluster-tool/clients/WIREClient"

/**
 * Structural assertions on the WIREClient companion namespace.
 *
 * The table-name enums (`OpregTable`, `MsgchTable`, etc.) are the source of
 * truth that the table-read methods pass to clio's `get_table_rows`. If the
 * contract renames a table, the enum entry here MUST move in lockstep —
 * these tests fail loudly when the two diverge.
 */
describe("WIREClient namespace", () => {
  describe("OpregTable", () => {
    it("maps Operators to the 'operators' table on sysio.opreg", () => {
      expect(WIREClient.OpregTable.Operators).toBe("operators")
    })

    it("maps WithdrawQueue to the 'wtdwqueue' table on sysio.opreg", () => {
      // `sysio.opreg::flushwtdw` walks this table; the contract-side name
      // is set in opreg.hpp's `[[sysio::table("wtdwqueue")]] withdraw_request`
      // declaration. A rename on either side without the other is a bug.
      expect(WIREClient.OpregTable.WithdrawQueue).toBe("wtdwqueue")
    })
  })

  describe("MsgchTable", () => {
    it("covers messages / envelopes / attestations / outenvelopes", () => {
      expect(WIREClient.MsgchTable.Messages).toBe("messages")
      expect(WIREClient.MsgchTable.Envelopes).toBe("envelopes")
      expect(WIREClient.MsgchTable.Attestations).toBe("attestations")
      expect(WIREClient.MsgchTable.OutEnvelopes).toBe("outenvelopes")
    })
  })

  describe("EpochTable", () => {
    it("covers epochstate / epochcfg / outposts", () => {
      expect(WIREClient.EpochTable.EpochState).toBe("epochstate")
      expect(WIREClient.EpochTable.EpochConfig).toBe("epochcfg")
      expect(WIREClient.EpochTable.Outposts).toBe("outposts")
    })
  })

  describe("UwritTable", () => {
    it("covers the uwrit-side tables consumed by flow tests", () => {
      expect(WIREClient.UwritTable.UnderwritingLedger).toBe("uwledger")
      expect(WIREClient.UwritTable.UnderwriteRequests).toBe("uwreqs")
      expect(WIREClient.UwritTable.Collateral).toBe("collateral")
    })
  })

  describe("Contract enum", () => {
    it("matches the sysio.* account names the depot deploys to", () => {
      expect(WIREClient.Contract.Epoch).toBe("sysio.epoch")
      expect(WIREClient.Contract.Opreg).toBe("sysio.opreg")
      expect(WIREClient.Contract.Msgch).toBe("sysio.msgch")
      expect(WIREClient.Contract.Uwrit).toBe("sysio.uwrit")
    })
  })
})
