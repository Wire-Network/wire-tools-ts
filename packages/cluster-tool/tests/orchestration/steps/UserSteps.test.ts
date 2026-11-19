import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

/** The user account every case provisions. */
const UserAccount = "flow.user"
/** A treasury funding amount in raw 9-dec WIRE base units. */
const FundWireAmount = 1_500_000_000n

describe("Steps.user", () => {
  it("provisionWire carries the account and its treasury funding", () => {
    const step = Steps.user.planProvisionWire(
      Report.Actor.User,
      "provision-user",
      `provision ${UserAccount} + fund it from the treasury`,
      {},
      UserAccount,
      FundWireAmount
    )
    expect(step.actor).toBe(Report.Actor.User)
    expect(step.input.kind).toBe("UserSteps.ProvisionWireInput")
    expect(step.input.account).toBe(UserAccount)
    expect(step.input.fundWireAmount).toBe(FundWireAmount)
    expect(typeof step.runner).toBe("function")
  })

  it("provisionWire accepts an unfunded user (0n)", () => {
    const step = Steps.user.planProvisionWire(
      Report.Actor.User,
      "provision-user",
      `provision ${UserAccount}`,
      {},
      UserAccount,
      0n
    )
    expect(step.input.fundWireAmount).toBe(0n)
  })

  it("provisionWire keys the account with the development key unless one is named", () => {
    const publicKey = PrivateKey.generate(KeyType.K1).toPublic().toString(),
      plan = (...key: string[]) =>
        Steps.user.planProvisionWire(
          Report.Actor.User,
          "provision-user",
          `provision ${UserAccount}`,
          {},
          UserAccount,
          0n,
          ...key
        )
    expect(plan().input.publicKey).toBe(Constants.DEV_K1_PUBLIC_KEY)
    expect(plan(publicKey).input.publicKey).toBe(publicKey)
  })
})
