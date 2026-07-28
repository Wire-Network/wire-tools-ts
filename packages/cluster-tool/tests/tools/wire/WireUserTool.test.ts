import type { WireClient } from "@wireio/cluster-tool"
import {
  DefaultWireUserResourcePolicy,
  formatWireAsset,
  provisionWireUser,
  type WireUserResourcePolicy
} from "@wireio/cluster-tool/tools/wire"

/** One captured `WireClient.invoke` call. */
interface CapturedInvoke {
  account: string
  action: string
  data: Record<string, unknown>
}

/** A stub WireClient capturing every invoke; account creation succeeds. */
function stubWireClient(calls: CapturedInvoke[]): WireClient {
  return {
    wallet: { unlock: async () => undefined },
    createAccount: async () => undefined,
    invoke: async (
      account: string,
      action: string,
      data: Record<string, unknown>
    ) => {
      calls.push({ account, action, data })
      return { transaction_id: "stub" }
    }
  } as unknown as WireClient
}

const LightPolicy: WireUserResourcePolicy = {
  netWeight: "1.0000 SYS",
  ramWeight: "1.0000 SYS",
  cpuWeight: "1.0000 SYS"
}

describe("formatWireAsset", () => {
  it("formats raw 9-decimal base units as a WIRE asset string", () => {
    expect(formatWireAsset(1_000_000_000n)).toBe("1.000000000 WIRE")
    expect(formatWireAsset(123_456_789n)).toBe("0.123456789 WIRE")
  })
})

describe("provisionWireUser", () => {
  it("attaches the DEFAULT resource policy when none is supplied", async () => {
    const calls: CapturedInvoke[] = []
    await provisionWireUser(stubWireClient(calls), "flowuser")
    const addpolicy = calls.find(call => call.action === "addpolicy")
    expect(addpolicy).toBeDefined()
    expect(addpolicy.data.net_weight).toBe(
      DefaultWireUserResourcePolicy.netWeight
    )
    expect(addpolicy.data.ram_weight).toBe(
      DefaultWireUserResourcePolicy.ramWeight
    )
    expect(addpolicy.data.cpu_weight).toBe(
      DefaultWireUserResourcePolicy.cpuWeight
    )
  })

  it("attaches the caller's resourcePolicy weights when supplied", async () => {
    const calls: CapturedInvoke[] = []
    await provisionWireUser(stubWireClient(calls), "stressw11122", {
      resourcePolicy: LightPolicy
    })
    const addpolicy = calls.find(call => call.action === "addpolicy")
    expect(addpolicy.data.net_weight).toBe(LightPolicy.netWeight)
    expect(addpolicy.data.ram_weight).toBe(LightPolicy.ramWeight)
    expect(addpolicy.data.cpu_weight).toBe(LightPolicy.cpuWeight)
  })

  it("funds via sysio.token::transfer only when fundWireAmount > 0", async () => {
    const funded: CapturedInvoke[] = []
    await provisionWireUser(stubWireClient(funded), "flowuser", {
      fundWireAmount: 2_000_000_000n
    })
    const transfer = funded.find(call => call.action === "transfer")
    expect(transfer).toBeDefined()
    expect(transfer.data.quantity).toBe("2.000000000 WIRE")

    const unfunded: CapturedInvoke[] = []
    await provisionWireUser(stubWireClient(unfunded), "flowuser")
    expect(unfunded.some(call => call.action === "transfer")).toBe(false)
  })
})
