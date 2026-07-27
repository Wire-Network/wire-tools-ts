import { Steps } from "@wireio/cluster-tool/orchestration"
import { SolanaClusterIdentityKey } from "@wireio/cluster-tool/orchestration/outputs"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { TestSolanaGenesisHash } from "../../config/clusterConfigFixture.js"

describe("Steps.solanaClusterIdentity", () => {
  const OtherGenesisHash = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
    signal = new AbortController().signal

  /** Stub the context's Solana client genesis response. */
  function reportedGenesisHash(
    value: string | Error
  ): ReturnType<typeof fixtureContext> {
    const ctx = fixtureContext(),
      spy = jest.spyOn(ctx.solana, "getGenesisHash")
    if (value instanceof Error) spy.mockRejectedValue(value)
    else spy.mockResolvedValue(value)
    return ctx
  }

  it("plans local provisioning with no pre-existing source of trust", () => {
    const step = Steps.solanaClusterIdentity.planProvisionLocal(
      Report.Actor.SolanaOutpost,
      "provision-solana-cluster-identity",
      "record local identity",
      {}
    )
    expect(step.input).toEqual({
      kind: "SolanaClusterIdentitySteps.ResolveInput",
      source: Steps.solanaClusterIdentity.Source.local,
      expectedGenesisHash: null
    })
  })

  it("records independently configured trust in the external verification plan", () => {
    const step = Steps.solanaClusterIdentity.planVerifyExternal(
      Report.Actor.SolanaOutpost,
      "verify-solana-cluster-identity",
      "verify external identity",
      {},
      TestSolanaGenesisHash
    )
    expect(step.input).toEqual({
      kind: "SolanaClusterIdentitySteps.ResolveInput",
      source: Steps.solanaClusterIdentity.Source.external,
      expectedGenesisHash: TestSolanaGenesisHash
    })
  })

  it("trusts and stores the locally controlled validator identity", async () => {
    const ctx = reportedGenesisHash(TestSolanaGenesisHash)
    await Steps.solanaClusterIdentity.runResolve(
      ctx,
      {
        kind: "SolanaClusterIdentitySteps.ResolveInput",
        source: Steps.solanaClusterIdentity.Source.local,
        expectedGenesisHash: null
      },
      signal
    )
    expect(ctx.outputs.assert(SolanaClusterIdentityKey)).toBe(
      TestSolanaGenesisHash
    )
  })

  it("accepts and stores an exact external identity match", async () => {
    const ctx = reportedGenesisHash(TestSolanaGenesisHash)
    await Steps.solanaClusterIdentity.runResolve(
      ctx,
      {
        kind: "SolanaClusterIdentitySteps.ResolveInput",
        source: Steps.solanaClusterIdentity.Source.external,
        expectedGenesisHash: TestSolanaGenesisHash
      },
      signal
    )
    expect(ctx.outputs.assert(SolanaClusterIdentityKey)).toBe(
      TestSolanaGenesisHash
    )
  })

  it("never derives external trust from the endpoint when expected identity is missing", async () => {
    const ctx = reportedGenesisHash(TestSolanaGenesisHash)
    await expect(
      Steps.solanaClusterIdentity.runResolve(
        ctx,
        {
          kind: "SolanaClusterIdentitySteps.ResolveInput",
          source: Steps.solanaClusterIdentity.Source.external,
          expectedGenesisHash: null
        },
        signal
      )
    ).rejects.toThrow(
      /requires an independently configured expected genesis hash/
    )
    expect(ctx.solana.getGenesisHash).not.toHaveBeenCalled()
    expect(ctx.outputs.has(SolanaClusterIdentityKey)).toBe(false)
  })

  it("fails closed without publishing output on a mismatch", async () => {
    const ctx = reportedGenesisHash(OtherGenesisHash)
    await expect(
      Steps.solanaClusterIdentity.runResolve(
        ctx,
        {
          kind: "SolanaClusterIdentitySteps.ResolveInput",
          source: Steps.solanaClusterIdentity.Source.external,
          expectedGenesisHash: TestSolanaGenesisHash
        },
        signal
      )
    ).rejects.toThrow(
      `expected ${TestSolanaGenesisHash}, observed ${OtherGenesisHash}`
    )
    expect(ctx.outputs.has(SolanaClusterIdentityKey)).toBe(false)
  })

  it("fails closed on a malformed endpoint response", async () => {
    const ctx = reportedGenesisHash("not-a-genesis-hash")
    await expect(
      Steps.solanaClusterIdentity.runResolve(
        ctx,
        {
          kind: "SolanaClusterIdentitySteps.ResolveInput",
          source: Steps.solanaClusterIdentity.Source.external,
          expectedGenesisHash: TestSolanaGenesisHash
        },
        signal
      )
    ).rejects.toThrow(/endpoint reported an invalid Solana genesis hash/)
    expect(ctx.outputs.has(SolanaClusterIdentityKey)).toBe(false)
  })

  it("fails closed when the endpoint is unavailable", async () => {
    const ctx = reportedGenesisHash(new Error("connection refused"))
    await expect(
      Steps.solanaClusterIdentity.runResolve(
        ctx,
        {
          kind: "SolanaClusterIdentitySteps.ResolveInput",
          source: Steps.solanaClusterIdentity.Source.external,
          expectedGenesisHash: TestSolanaGenesisHash
        },
        signal
      )
    ).rejects.toThrow(/getGenesisHash failed before operator launch/)
    expect(ctx.outputs.has(SolanaClusterIdentityKey)).toBe(false)
  })

  it("fails closed when the endpoint never responds", async () => {
    jest.useFakeTimers()
    try {
      const ctx = fixtureContext()
      jest
        .spyOn(ctx.solana, "getGenesisHash")
        .mockReturnValue(new Promise<string>(() => undefined))
      const resolution = expect(
        Steps.solanaClusterIdentity.runResolve(
          ctx,
          {
            kind: "SolanaClusterIdentitySteps.ResolveInput",
            source: Steps.solanaClusterIdentity.Source.external,
            expectedGenesisHash: TestSolanaGenesisHash
          },
          signal
        )
      ).rejects.toThrow(/getGenesisHash timed out after 10000ms/)

      await jest.advanceTimersByTimeAsync(10_000)
      await resolution
      expect(ctx.outputs.has(SolanaClusterIdentityKey)).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it("rejects a changed local validator against persisted state", async () => {
    const ctx = reportedGenesisHash(OtherGenesisHash)
    await expect(
      Steps.solanaClusterIdentity.runResolve(
        ctx,
        {
          kind: "SolanaClusterIdentitySteps.ResolveInput",
          source: Steps.solanaClusterIdentity.Source.local,
          expectedGenesisHash: TestSolanaGenesisHash
        },
        signal
      )
    ).rejects.toThrow(/local Solana cluster identity mismatch/)
  })
})
