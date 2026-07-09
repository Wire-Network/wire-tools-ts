import {
  addResourcePolicy,
  createAccountWithRam,
  createAccountWithResources,
  isAccountAlreadyExistsError
} from "@wireio/test-cluster-tool/cluster/accountProvisioning"
import {
  BOOTSTRAP_NODE_OWNER,
  DEFAULT_RAM_WEIGHT,
  DEFAULT_RESOURCE_WEIGHT
} from "@wireio/test-cluster-tool/cluster/constants"
import type { Clio } from "@wireio/test-cluster-tool/clients/Clio"

/**
 * Unit coverage for the shared account-provisioning helpers (extracted from
 * `ClusterManager` privates). A stub Clio records the calls each helper
 * makes — no live cluster involved.
 */

/** Minimal Clio stub recording createAccount + pushActionAndWait calls. */
const makeClioStub = (overrides: Partial<Record<string, jest.Mock>> = {}) => {
  const stub = {
    createAccount: jest.fn().mockResolvedValue("txid"),
    pushActionAndWait: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
  return { stub, clio: stub as unknown as Clio }
}

describe("isAccountAlreadyExistsError", () => {
  it("recognises the fragment in err.message", () => {
    expect(
      isAccountAlreadyExistsError(new Error("Account name already exists"))
    ).toBe(true)
  })

  it("recognises the fragment in err.stderr", () => {
    expect(
      isAccountAlreadyExistsError({ stderr: "error: already exists on chain" })
    ).toBe(true)
  })

  it("rejects unrelated errors and null", () => {
    expect(isAccountAlreadyExistsError(new Error("insufficient ram"))).toBe(
      false
    )
    expect(isAccountAlreadyExistsError(null)).toBe(false)
  })
})

describe("createAccountWithRam", () => {
  it("creates the account through sysio::newaccount and waits for finality", async () => {
    const { stub, clio } = makeClioStub()
    await createAccountWithRam(clio, "freshop", "SYS_KEY")
    expect(stub.createAccount).not.toHaveBeenCalled()
    expect(stub.pushActionAndWait).toHaveBeenCalledWith(
      "sysio",
      "newaccount",
      {
        creator: "sysio",
        name: "freshop",
        owner: {
          threshold: 1,
          keys: [{ key: "SYS_KEY", weight: 1 }],
          accounts: [],
          waits: []
        },
        active: {
          threshold: 1,
          keys: [{ key: "SYS_KEY", weight: 1 }],
          accounts: [],
          waits: []
        }
      },
      "sysio@active"
    )
  })

  it("swallows the benign already-exists rejection", async () => {
    const { clio } = makeClioStub({
      pushActionAndWait: jest
        .fn()
        .mockRejectedValue(new Error("account freshop already exists"))
    })
    await expect(
      createAccountWithRam(clio, "freshop", "SYS_KEY")
    ).resolves.toBeUndefined()
  })

  it("rethrows any other failure with the account name in the message", async () => {
    const { clio } = makeClioStub({
      pushActionAndWait: jest
        .fn()
        .mockRejectedValue(new Error("rpc unreachable"))
    })
    await expect(
      createAccountWithRam(clio, "freshop", "SYS_KEY")
    ).rejects.toThrow(/freshop.*rpc unreachable/)
  })
})

describe("addResourcePolicy", () => {
  it("pushes sysio.roa::addpolicy signed by the issuer with default weights", async () => {
    const { stub, clio } = makeClioStub()
    await addResourcePolicy(clio, "freshop", "wireno")
    expect(stub.pushActionAndWait).toHaveBeenCalledWith(
      "sysio.roa",
      "addpolicy",
      {
        owner: "freshop",
        issuer: "wireno",
        net_weight: DEFAULT_RESOURCE_WEIGHT,
        ram_weight: DEFAULT_RAM_WEIGHT,
        cpu_weight: DEFAULT_RESOURCE_WEIGHT,
        time_block: 0,
        network_gen: 0
      },
      "wireno@active"
    )
  })

  it("honours explicit weight overrides", async () => {
    const { stub, clio } = makeClioStub()
    await addResourcePolicy(clio, "freshop", "wireno", "1.0000 SYS")
    const payload = stub.pushActionAndWait.mock.calls[0][2]
    expect(payload.net_weight).toBe("1.0000 SYS")
    expect(payload.ram_weight).toBe(DEFAULT_RAM_WEIGHT)
  })
})

describe("createAccountWithResources", () => {
  it("creates the account then issues the policy from the bootstrap node owner by default", async () => {
    const { stub, clio } = makeClioStub()
    await createAccountWithResources(clio, "freshop", "SYS_KEY")
    expect(stub.createAccount).not.toHaveBeenCalled()
    expect(stub.pushActionAndWait).toHaveBeenCalledTimes(2)
    const payload = stub.pushActionAndWait.mock.calls[1][2]
    expect(payload.issuer).toBe(BOOTSTRAP_NODE_OWNER)
    expect(stub.pushActionAndWait.mock.calls[1][3]).toBe(
      `${BOOTSTRAP_NODE_OWNER}@active`
    )
  })

  it("threads a custom issuer through to the policy", async () => {
    const { stub, clio } = makeClioStub()
    await createAccountWithResources(clio, "freshop", "SYS_KEY", "voter1")
    expect(stub.pushActionAndWait.mock.calls[1][2].issuer).toBe("voter1")
  })
})
