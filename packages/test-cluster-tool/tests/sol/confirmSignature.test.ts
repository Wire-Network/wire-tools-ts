import type { Connection } from "@solana/web3.js"
import { confirmSignature } from "@wireio/test-cluster-tool/sol/confirmSignature"

/** A Connection stub exposing only the method confirmSignature uses. */
const fakeConn = (getSignatureStatus: jest.Mock): Connection =>
  ({ getSignatureStatus } as unknown as Connection)

const confirmed = (conf: string) => ({ value: { confirmationStatus: conf, err: null } })
const failed = (err: unknown) => ({ value: { confirmationStatus: "processed", err } })
const pending = () => ({ value: null })

afterEach(() => jest.restoreAllMocks())

describe("confirmSignature", () => {
  it("resolves once the signature reaches confirmed/finalized", async () => {
    const gss = jest
      .fn()
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(confirmed("confirmed"))
    await expect(
      confirmSignature(fakeConn(gss), "sig", "t", { intervalMs: 1 })
    ).resolves.toBeUndefined()
  })

  it("throws when the tx reports an error", async () => {
    const gss = jest.fn().mockResolvedValue(failed({ InstructionError: [0, "Custom"] }))
    await expect(
      confirmSignature(fakeConn(gss), "sig", "t", { intervalMs: 1 })
    ).rejects.toThrow(/tx failed/)
  })

  it("honors the deadline even when each status RPC hangs", async () => {
    // getSignatureStatus never settles. Without the per-RPC timeout this would
    // hang forever (the original bug); confirmSignature must still throw at the
    // deadline because each poll is bounded by rpcTimeoutMs.
    const gss = jest.fn().mockImplementation(() => new Promise(() => {}))
    await expect(
      confirmSignature(fakeConn(gss), "sig", "t", {
        deadlineMs: 200,
        rpcTimeoutMs: 20,
        intervalMs: 1
      })
    ).rejects.toThrow(/not confirmed within 200ms/)
  })

  it("rebroadcasts while the tx is still unconfirmed", async () => {
    let polls = 0
    const gss = jest.fn().mockImplementation(async () =>
      ++polls >= 5 ? confirmed("finalized") : pending()
    )
    const rebroadcast = jest.fn().mockResolvedValue(undefined)
    await confirmSignature(fakeConn(gss), "sig", "t", {
      intervalMs: 1,
      rebroadcastMs: 1,
      rebroadcast
    })
    expect(rebroadcast).toHaveBeenCalled()
  })

  it("does not rebroadcast when none is provided", async () => {
    const gss = jest
      .fn()
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(confirmed("confirmed"))
    await expect(
      confirmSignature(fakeConn(gss), "sig", "t", { intervalMs: 1 })
    ).resolves.toBeUndefined()
  })
})
