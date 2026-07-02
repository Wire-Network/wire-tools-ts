import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.account.createSystem", () => {
  it("carries the system account as typed input", () => {
    const step = Steps.account.createSystem(
      Report.Actor.Sysio,
      "create-opreg",
      "create sysio.opreg system account",
      {},
      "sysio.opreg"
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.name).toBe("create-opreg")
    expect(step.input.kind).toBe("AccountSteps.CreateSystemInput")
    expect(step.input.account).toBe("sysio.opreg")
    expect(typeof step.runner).toBe("function")
  })
})

describe("Steps.account.createKeyed", () => {
  it("carries account + key + default sysio creator", () => {
    const step = Steps.account.createKeyed(
      Report.Actor.Producer,
      "create-producer",
      "create a keyed producer account",
      {},
      "produceraaa",
      "PUB_K1_producerkey"
    )
    expect(step.actor).toBe(Report.Actor.Producer)
    expect(step.input.kind).toBe("AccountSteps.CreateKeyedInput")
    expect(step.input.account).toBe("produceraaa")
    expect(step.input.publicKey).toBe("PUB_K1_producerkey")
    expect(step.input.creator).toBe("sysio")
  })

  it("honors an explicit creator override", () => {
    const step = Steps.account.createKeyed(
      Report.Actor.User,
      "create-user",
      "create a keyed user account from a non-sysio creator",
      {},
      "useraccount",
      "PUB_K1_userkey",
      "creatoracct"
    )
    expect(step.input.creator).toBe("creatoracct")
  })
})
