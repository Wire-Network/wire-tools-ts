import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { provisionWireUser } from "@wireio/cluster-tool/tools/wire"

/** The account every case provisions. */
const UserAccount = "flow.user"

/** A WIRE client whose wallet unlocks and whose `createAccount` resolves, or rejects with `failure`. */
function wireFor(failure: Error = null) {
  const createAccount = jest.fn(async () => {
      if (failure != null) throw failure
    }),
    invoke = jest.fn().mockResolvedValue(null)
  return {
    createAccount,
    invoke,
    wire: {
      wallet: { unlock: jest.fn().mockResolvedValue(null) },
      createAccount,
      invoke
    } as unknown as WireClient
  }
}

describe("provisionWireUser", () => {
  it("creates the account under the development key by default, unfunded", async () => {
    const { wire, createAccount, invoke } = wireFor()
    expect(await provisionWireUser(wire, UserAccount)).toEqual({
      account: UserAccount,
      accountBytes: new TextEncoder().encode(UserAccount)
    })
    expect(createAccount).toHaveBeenCalledWith(
      "sysio",
      UserAccount,
      Constants.DEV_K1_PUBLIC_KEY,
      Constants.DEV_K1_PUBLIC_KEY
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it("creates the account under the key the caller names, on owner and active", async () => {
    const { wire, createAccount } = wireFor(),
      publicKey = PrivateKey.generate(KeyType.K1).toPublic().toString()
    await provisionWireUser(wire, UserAccount, { publicKey })
    expect(createAccount).toHaveBeenCalledWith("sysio", UserAccount, publicKey, publicKey)
  })

  it("wraps a creation failure, keeping it as the cause", async () => {
    const failure = new Error("transaction net usage is too high"),
      { wire } = wireFor(failure),
      provisioned = provisionWireUser(wire, UserAccount)
    await expect(provisioned).rejects.toBeInstanceOf(NestedError)
    await expect(provisioned).rejects.toHaveProperty("cause", failure)
  })
})
