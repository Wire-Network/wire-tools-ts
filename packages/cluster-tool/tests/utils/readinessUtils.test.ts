import { SlugName, SysioContracts } from "@wireio/sdk-core"

import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessEndpointLabel,
  readinessReserveLabel,
  readinessSlug
} from "@wireio/cluster-tool/utils"

describe("readinessEndpointLabel", () => {
  it("retains routing information while removing secrets", () => {
    expect(
      readinessEndpointLabel(
        "https://operator:secret@wire.example/v1/health?token=hidden#fragment"
      )
    ).toBe("https://wire.example/v1/health")
  })
})

describe("readiness table evidence utilities", () => {
  it("formats generated slug cells and reserve labels", () => {
    const chainCode = { value: SlugName.from("ETHEREUM") },
      tokenCode = { value: SlugName.from("ETH") },
      reserveCode = { value: SlugName.from("PRIMARY") },
      reserve = {
        chain_code: chainCode,
        token_code: tokenCode,
        reserve_code: reserveCode
      } as SysioContracts.SysioReservReserveRowType
    expect(readinessSlug(chainCode)).toBe("ETHEREUM")
    expect(readinessReserveLabel(reserve)).toBe("ETHEREUM/ETH/PRIMARY")
  })

  it("accepts complete bounded results and rejects truncated scans", async () => {
    await expect(
      readinessBoundedQuery(Promise.resolve({ more: false, rows: [1] }), "rows")
    ).resolves.toEqual({ more: false, rows: [1] })
    await expect(
      readinessBoundedQuery(Promise.resolve({ more: true, rows: [] }), "rows")
    ).rejects.toThrow(`${ReadinessMaxTableRows}-row readiness scan limit`)
  })
})
