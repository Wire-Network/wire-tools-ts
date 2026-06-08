import Fs from "fs"
import { ABI, Name, Serializer } from "@wireio/sdk-core"
import { Clio } from "@wireio/test-cluster-tool/clients/Clio"
import {
  createSysioAccount,
  deploySysContract,
  sysioActiveAuthority,
  sysioActiveCodeAuthority
} from "@wireio/test-cluster-tool/cluster/sysContractDeploy"

/**
 * Unit tests for the production-path system-contract deployment helpers.
 *
 * The two authority builders are pure and tested directly; the two async
 * deploy/create helpers are exercised against a Clio whose action-push methods
 * are mocked, so the tests assert the exact actions/args/order they emit
 * without spawning a cluster.
 */

/** Construct a Clio with a non-existent wallet path (constructor skips the read). */
const makeClio = (): Clio =>
  new Clio({
    clusterPath: "/tmp/__sysContractDeploy_test_nonexistent__",
    binary: "/bin/false",
    url: "http://127.0.0.1:65535"
  })

/** Minimal but valid `abi_def` the antelope serializer can pack. */
const MIN_ABI = {
  version: "sysio::abi/1.2",
  types: [],
  structs: [],
  actions: [],
  tables: [],
  ricardian_clauses: [],
  variants: []
}

afterEach(() => jest.restoreAllMocks())

describe("sysioActiveAuthority", () => {
  it("is governed solely by sysio@active with no standalone key", () => {
    expect(sysioActiveAuthority()).toEqual({
      threshold: 1,
      keys: [],
      accounts: [
        { permission: { actor: "sysio", permission: "active" }, weight: 1 }
      ],
      waits: []
    })
  })
})

describe("sysioActiveCodeAuthority", () => {
  it("with no code accounts is exactly sysio@active", () => {
    expect(sysioActiveCodeAuthority([])).toEqual(sysioActiveAuthority())
  })

  it("keeps the sysio@active base and adds each account's @sysio.code weight", () => {
    const auth = sysioActiveCodeAuthority(["sysio.token"])
    expect(auth.threshold).toBe(1)
    expect(auth.keys).toEqual([])
    expect(auth.accounts).toHaveLength(2)
    expect(auth.accounts[0]).toEqual({
      permission: { actor: "sysio", permission: "active" },
      weight: 1
    })
    expect(auth.accounts).toContainEqual({
      permission: { actor: "sysio.token", permission: "sysio.code" },
      weight: 1
    })
  })

  it("sorts accounts ascending by name value, sysio@active first (authority-encoding requirement)", () => {
    const auth = sysioActiveCodeAuthority([
      "sysio.uwrit",
      "sysio.token",
      "sysio.epoch"
    ])
    // sysio sorts before every sysio.* account.
    expect(auth.accounts[0].permission).toEqual({
      actor: "sysio",
      permission: "active"
    })
    const values = auth.accounts.map(a => Name.from(a.permission.actor).value.value)
    const sorted = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    expect(values).toEqual(sorted)
  })
})

describe("createSysioAccount", () => {
  it("creates the account via sysio::newaccount governed by sysio@active", async () => {
    const clio = makeClio()
    const push = jest
      .spyOn(clio, "pushActionAndWait")
      .mockResolvedValue({} as never)

    await createSysioAccount(clio, "sysio.token")

    expect(push).toHaveBeenCalledTimes(1)
    const [account, action, data, auth] = push.mock.calls[0]
    expect(account).toBe("sysio")
    expect(action).toBe("newaccount")
    expect(auth).toBe("sysio@active")
    expect(data).toEqual({
      creator: "sysio",
      name: "sysio.token",
      owner: sysioActiveAuthority(),
      active: sysioActiveAuthority()
    })
  })
})

describe("deploySysContract", () => {
  it("deploys via setsyscode then setsysabi, both authorized by sysio@active", async () => {
    const clio = makeClio()
    const wasmBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    jest.spyOn(Fs, "readFileSync").mockImplementation(((p: unknown) =>
      String(p).endsWith(".wasm") ? wasmBytes : JSON.stringify(MIN_ABI)
    ) as unknown as typeof Fs.readFileSync)
    const push = jest
      .spyOn(clio, "pushActionFileAndWait")
      .mockResolvedValue({} as never)

    await deploySysContract(
      clio,
      "sysio.token",
      "/x/sysio.token.wasm",
      "/x/sysio.token.abi"
    )

    expect(push).toHaveBeenCalledTimes(2)

    // setsyscode carries the wasm as hex code, billed to sysio@active.
    expect(push.mock.calls[0][0]).toBe("sysio.roa")
    expect(push.mock.calls[0][1]).toBe("setsyscode")
    expect(push.mock.calls[0][2]).toEqual({
      account: "sysio.token",
      vmtype: 0,
      vmversion: 0,
      code: "deadbeef"
    })
    expect(push.mock.calls[0][3]).toBe("sysio@active")

    // setsysabi carries the PACKED abi_def hex (not the JSON text).
    expect(push.mock.calls[1][0]).toBe("sysio.roa")
    expect(push.mock.calls[1][1]).toBe("setsysabi")
    expect(push.mock.calls[1][3]).toBe("sysio@active")
    const abiArg = push.mock.calls[1][2] as { account: string; abi: string }
    expect(abiArg.account).toBe("sysio.token")
    const expectedAbiHex = Serializer.encode({
      object: ABI.from(MIN_ABI),
      type: ABI
    }).hexString
    expect(abiArg.abi).toBe(expectedAbiHex)
  })
})
