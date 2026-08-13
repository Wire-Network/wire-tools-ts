import { SlugName, SysioContracts } from "@wireio/sdk-core"

import {
  ReadinessMaxTableRows,
  readinessBoundedQuery,
  readinessErrorMessage,
  readinessEnumMatches,
  readinessReserveLabel
} from "@wireio/cluster-tool/readiness"

const EthereumChainCode = { value: SlugName.from("ETHEREUM") },
  EthereumTokenCode = { value: SlugName.from("ETH") },
  PrimaryReserveCode = { value: SlugName.from("PRIMARY") }

function reserve(): SysioContracts.SysioReservReserveRowType {
  return {
    chain_code: EthereumChainCode,
    token_code: EthereumTokenCode,
    reserve_code: PrimaryReserveCode,
    name: "Primary",
    description: "Public reserve",
    status: SysioContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
    reserve_chain_amount: 1,
    reserve_wire_amount: 1,
    source_token_precision: 9,
    connector_weight_bps: 5_000,
    creator_addr: {
      kind: SysioContracts.SysioReservChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    requested_wire_amount: 1,
    external_token_amount: 1,
    registered_at_ms: 0,
    activated_at_ms: 0,
    cancelled_at_ms: 0,
    is_private: false,
    owner: "",
    creator_pub_key: "",
    owner_fee_bps: 0,
    owner_fee_accrued: 0,
    owner_fee_lifetime: 0
  }
}

describe("readiness utilities", () => {
  it("formats generated enum, slug, reserve, and error values", () => {
    expect(readinessEnumMatches(1, 1, "ACTIVE")).toBe(true)
    expect(readinessEnumMatches("1", 1, "ACTIVE")).toBe(true)
    expect(readinessEnumMatches("ACTIVE", 1, "ACTIVE")).toBe(true)
    expect(readinessEnumMatches("INACTIVE", 1, "ACTIVE")).toBe(false)
    expect(readinessReserveLabel(reserve())).toBe("ETHEREUM/ETH/PRIMARY")
    expect(readinessErrorMessage(new Error("offline"))).toBe("offline")
    expect(readinessErrorMessage("unavailable")).toBe("unavailable")
  })

  it("accepts a complete bounded query and rejects a truncated one", async () => {
    await expect(
      readinessBoundedQuery(
        Promise.resolve({ rows: [1], more: false }),
        "complete table"
      )
    ).resolves.toEqual({ rows: [1], more: false })
    await expect(
      readinessBoundedQuery(
        Promise.resolve({ rows: [], more: true }),
        "truncated table"
      )
    ).rejects.toThrow(
      `truncated table exceeds the ${ReadinessMaxTableRows}-row readiness scan limit`
    )
  })
})
