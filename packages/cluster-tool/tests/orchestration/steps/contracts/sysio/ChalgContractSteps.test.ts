import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { ETHEREUM_CHAIN_CODENAME: Ethereum, SOLANA_CHAIN_CODENAME: Solana } = Constants,
  { DISPUTE_STATUS_OPEN: Open, DISPUTE_STATUS_RESOLVED: Resolved } = SysioContracts.SysioChalgDisputestatus,
  ContestedEpoch = 7

/** A `disputes` row on `chain`'s epoch `epochIndex`, as the RPC renders it (a packed code). */
function disputeRow(
  id: number,
  chain: Constants.OutpostChainCodename,
  epochIndex: number,
  status: SysioContracts.SysioChalgDisputeEntryType["status"] = Open
): SysioContracts.SysioChalgDisputeEntryType {
  return {
    id,
    chain_code: String(SlugName.from(chain)),
    epoch_index: epochIndex,
    status,
    winning_checksum: "",
    opened_at: "2026-11-24T00:00:00.000",
    deadline: "2026-11-25T00:00:00.000",
    candidates: [],
    network_gen: 0,
    electorate: [],
    quorum: 0
  }
}

/** A real context whose `sysio.chalg` client serves `rows` from its `disputes` table. */
function disputesContext(rows: SysioContracts.SysioChalgDisputeEntryType[], more = false) {
  const ctx = fixtureContext(),
    contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.chalg)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  const query = jest.spyOn(contract.tables.disputes, "query").mockResolvedValue({ rows, more })
  return { ctx, query }
}

describe("Steps.contracts.sysio.chalg", () => {
  afterEach(() => jest.restoreAllMocks())

  it("readDisputes returns every row of one bounded read", async () => {
    const rows = [disputeRow(1, Ethereum, ContestedEpoch), disputeRow(2, Solana, 3, Resolved)],
      { ctx, query } = disputesContext(rows)
    await expect(Steps.contracts.sysio.chalg.readDisputes(ctx)).resolves.toEqual(rows)
    expect(query).toHaveBeenCalledWith({ limit: Steps.contracts.sysio.chalg.DisputeRowLimit })
  })

  it("readDisputes refuses a truncated read", async () => {
    const { ctx } = disputesContext([disputeRow(1, Ethereum, ContestedEpoch)], true)
    await expect(Steps.contracts.sysio.chalg.readDisputes(ctx)).rejects.toThrow(/truncated/)
  })

  it("outpostEpochKey puts the chain's packed code above the epoch's 32 bits", () => {
    expect(Steps.contracts.sysio.chalg.outpostEpochKey(Ethereum, ContestedEpoch)).toBe(
      BigInt(SlugName.from(Ethereum)) * 2n ** 32n + BigInt(ContestedEpoch)
    )
    expect(Steps.contracts.sysio.chalg.outpostEpochKey(Ethereum, ContestedEpoch + 1)).toBe(
      Steps.contracts.sysio.chalg.outpostEpochKey(Ethereum, ContestedEpoch) + 1n
    )
  })

  it("readEpochDispute reads one row at the epoch's byoutepoch key", async () => {
    const row = disputeRow(4, Ethereum, ContestedEpoch),
      { ctx, query } = disputesContext([row])
    await expect(Steps.contracts.sysio.chalg.readEpochDispute(ctx, Ethereum, ContestedEpoch)).resolves.toBe(row)
    expect(query).toHaveBeenCalledWith({
      indexName: Steps.contracts.sysio.chalg.OutpostEpochIndex,
      lowerBound: JSON.stringify({
        [Steps.contracts.sysio.chalg.OutpostEpochIndex]: Steps.contracts.sysio.chalg
          .outpostEpochKey(Ethereum, ContestedEpoch)
          .toString()
      }),
      limit: 1
    })
  })

  it("readEpochDispute answers nothing when the row past the key is another epoch's or chain's", async () => {
    for (const later of [disputeRow(5, Ethereum, ContestedEpoch + 1), disputeRow(6, Solana, ContestedEpoch)]) {
      const { ctx } = disputesContext([later])
      await expect(Steps.contracts.sysio.chalg.readEpochDispute(ctx, Ethereum, ContestedEpoch)).resolves.toBeUndefined()
      jest.restoreAllMocks()
    }
    const { ctx } = disputesContext([])
    await expect(Steps.contracts.sysio.chalg.readEpochDispute(ctx, Ethereum, ContestedEpoch)).resolves.toBeUndefined()
  })

  it("isDisputeOf matches the chain and the epoch, open or resolved", () => {
    expect(Steps.contracts.sysio.chalg.isDisputeOf(disputeRow(1, Ethereum, ContestedEpoch, Resolved), Ethereum, ContestedEpoch)).toBe(
      true
    )
    expect(Steps.contracts.sysio.chalg.isDisputeOf(disputeRow(2, Solana, ContestedEpoch), Ethereum, ContestedEpoch)).toBe(false)
    expect(
      Steps.contracts.sysio.chalg.isDisputeOf(disputeRow(3, Ethereum, ContestedEpoch - 1), Ethereum, ContestedEpoch)
    ).toBe(false)
  })

  it("isOpenDispute matches the chain's open dispute at the epoch, by status spelling or value", () => {
    expect(Steps.contracts.sysio.chalg.isOpenDispute(disputeRow(1, Ethereum, ContestedEpoch), Ethereum, ContestedEpoch)).toBe(
      true
    )
    expect(
      Steps.contracts.sysio.chalg.isOpenDispute(
        disputeRow(2, Ethereum, ContestedEpoch, "DISPUTE_STATUS_OPEN"),
        Ethereum,
        ContestedEpoch
      )
    ).toBe(true)
  })

  it("isOpenDispute refuses another chain, another epoch and a resolved dispute", () => {
    expect(Steps.contracts.sysio.chalg.isOpenDispute(disputeRow(1, Solana, ContestedEpoch), Ethereum, ContestedEpoch)).toBe(
      false
    )
    expect(
      Steps.contracts.sysio.chalg.isOpenDispute(disputeRow(2, Ethereum, ContestedEpoch + 1), Ethereum, ContestedEpoch)
    ).toBe(false)
    expect(
      Steps.contracts.sysio.chalg.isOpenDispute(disputeRow(3, Ethereum, ContestedEpoch, Resolved), Ethereum, ContestedEpoch)
    ).toBe(false)
  })

  it("isOpenDispute refuses a chain code that is not a packed code rather than misreading it", () => {
    expect(() =>
      Steps.contracts.sysio.chalg.isOpenDispute(
        { ...disputeRow(1, Ethereum, ContestedEpoch), chain_code: Ethereum },
        Ethereum,
        ContestedEpoch
      )
    ).toThrow(/unsigned decimal/)
  })
})
