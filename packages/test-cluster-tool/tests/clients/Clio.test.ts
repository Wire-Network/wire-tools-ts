import Fs from "fs"
import { Clio, ClioErrorFragment } from "@wireio/test-cluster-tool/clients/Clio"
import { DEFAULT_WALLET_NAME } from "@wireio/test-cluster-tool/cluster/constants"

/**
 * Finality / fork-retry behaviour for {@link Clio}.
 *
 * Inclusion in a block is NOT finality — a freshly produced block can be
 * orphaned by a fork before it reaches the chain's last-irreversible height,
 * silently discarding the transaction (this is exactly what wedged epoch
 * bootstrap: the `epoch::advance` block was orphaned and never re-applied).
 * These tests pin the three guarantees that fix it:
 *   1. `blockContainsTransaction` correctly reads both `trx` shapes.
 *   2. `waitForTransactionIrreversible` only succeeds once the tx is in a block
 *      at or below LIB, tolerating a fork that re-applies it at a new height.
 *   3. The `*AndWait` family re-pushes a forked-out tx and gives up after
 *      `FinalityMaxAttempts`.
 */

/** Construct a Clio with a non-existent wallet path (constructor skips the read). */
const makeClio = (): Clio =>
  new Clio({
    clusterPath: "/tmp/__clio_finality_test_nonexistent__",
    binary: "/bin/false",
    url: "http://127.0.0.1:65535"
  })

/** Block fixture carrying the given tx ids as bare-string `trx` entries. */
const blockWith = (
  blockNum: number,
  txIds: string[]
): Clio.IGetBlockResponse => ({
  block_num: blockNum,
  id: `blk-${blockNum}`,
  timestamp: "",
  producer: "",
  transactions: txIds.map(id => ({ status: "executed", trx: id }))
})

const info = (lib: number) => ({ last_irreversible_block_num: lib }) as never

afterEach(() => jest.restoreAllMocks())

describe("Clio.blockContainsTransaction", () => {
  it("matches a bare-string trx id", () => {
    expect(
      Clio.blockContainsTransaction(blockWith(1, ["abc", "def"]), "def")
    ).toBe(true)
  })

  it("matches an object trx.id", () => {
    const block = {
      block_num: 1,
      id: "b",
      timestamp: "",
      producer: "",
      transactions: [{ status: "executed", trx: { id: "xyz" } }]
    } as Clio.IGetBlockResponse
    expect(Clio.blockContainsTransaction(block, "xyz")).toBe(true)
  })

  it("returns false when the tx id is absent", () => {
    expect(Clio.blockContainsTransaction(blockWith(1, ["abc"]), "zzz")).toBe(
      false
    )
  })

  it("returns false for an empty or missing transaction list", () => {
    expect(Clio.blockContainsTransaction(blockWith(1, []), "abc")).toBe(false)
    expect(
      Clio.blockContainsTransaction({ transactions: undefined } as never, "abc")
    ).toBe(false)
  })
})

describe("Clio#waitForTransactionIrreversible", () => {
  it("resolves true once LIB ≥ height and the block still contains the tx", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "getInfo").mockResolvedValue(info(100))
    jest.spyOn(clio, "getBlock").mockResolvedValue(blockWith(50, ["tx1"]))
    await expect(clio.waitForTransactionIrreversible("tx1", 50)).resolves.toBe(
      true
    )
  })

  it("resolves false when the now-final block lost the tx and it is gone (forked out)", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "getInfo").mockResolvedValue(info(100))
    jest.spyOn(clio, "getBlock").mockResolvedValue(blockWith(50, ["other"]))
    jest.spyOn(clio, "getTransaction").mockResolvedValue(null as never)
    await expect(clio.waitForTransactionIrreversible("tx1", 50)).resolves.toBe(
      false
    )
  })

  it("follows a fork that re-applied the tx at a new height", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "getInfo").mockResolvedValue(info(100))
    jest
      .spyOn(clio, "getBlock")
      .mockImplementation(async num =>
        blockWith(num as number, num === 60 ? ["tx1"] : ["other"])
      )
    // original height 50 lost it; trace now reports it re-applied at 60
    jest
      .spyOn(clio, "getTransaction")
      .mockResolvedValue({ id: "tx1", block_num: 60, block_time: "" } as never)
    await expect(
      clio.waitForTransactionIrreversible("tx1", 50, 5_000)
    ).resolves.toBe(true)
  }, 10_000)

  it("resolves false when LIB never reaches the height within the timeout", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "getInfo").mockResolvedValue(info(10))
    const getBlock = jest.spyOn(clio, "getBlock")
    await expect(
      clio.waitForTransactionIrreversible("tx1", 50, 50)
    ).resolves.toBe(false)
    expect(getBlock).not.toHaveBeenCalled()
  })
})

describe("Clio#pushActionAndWait finality retry", () => {
  it("returns after the first push when the tx reaches finality", async () => {
    const clio = makeClio()
    const push = jest
      .spyOn(clio, "pushAction")
      .mockResolvedValue({ transaction_id: "tx1" } as never)
    jest.spyOn(clio, "waitForTransactionInBlock").mockResolvedValue(10)
    jest.spyOn(clio, "waitForTransactionIrreversible").mockResolvedValue(true)

    const res = await clio.pushActionAndWait("acct", "act", {}, "acct@active")
    expect(res).toEqual({ transaction_id: "tx1" })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("re-pushes the action when its block is forked out before finality", async () => {
    const clio = makeClio()
    const push = jest
      .spyOn(clio, "pushAction")
      .mockResolvedValueOnce({ transaction_id: "tx1" } as never)
      .mockResolvedValueOnce({ transaction_id: "tx2" } as never)
    jest.spyOn(clio, "waitForTransactionInBlock").mockResolvedValue(10)
    jest
      .spyOn(clio, "waitForTransactionIrreversible")
      .mockResolvedValueOnce(false) // tx1 forked out
      .mockResolvedValueOnce(true) // tx2 final

    const res = await clio.pushActionAndWait("acct", "act", {}, "acct@active")
    expect(res).toEqual({ transaction_id: "tx2" })
    expect(push).toHaveBeenCalledTimes(2)
  }, 10_000)

  it("throws after FinalityMaxAttempts forked-out pushes", async () => {
    const clio = makeClio()
    const push = jest
      .spyOn(clio, "pushAction")
      .mockResolvedValue({ transaction_id: "tx" } as never)
    jest.spyOn(clio, "waitForTransactionInBlock").mockResolvedValue(10)
    jest.spyOn(clio, "waitForTransactionIrreversible").mockResolvedValue(false)

    await expect(
      clio.pushActionAndWait("acct", "act", {}, "acct@active")
    ).rejects.toThrow(/forked out before irreversibility/)
    expect(push).toHaveBeenCalledTimes(Clio.FinalityMaxAttempts)
  }, 15_000)

  it("returns without confirming when the push result has no transaction_id", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "pushAction").mockResolvedValue({} as never)
    const inBlock = jest.spyOn(clio, "waitForTransactionInBlock")

    const res = await clio.pushActionAndWait("acct", "act", {}, "acct@active")
    expect(res).toEqual({})
    expect(inBlock).not.toHaveBeenCalled()
  })

  it("with finality=head, confirms in-block only — no irreversibility wait", async () => {
    const clio = makeClio()
    const push = jest
      .spyOn(clio, "pushAction")
      .mockResolvedValue({ transaction_id: "tx1" } as never)
    const inBlock = jest
      .spyOn(clio, "waitForTransactionInBlock")
      .mockResolvedValue(10)
    const irr = jest.spyOn(clio, "waitForTransactionIrreversible")

    const res = await clio.pushActionAndWait(
      "acct",
      "act",
      {},
      "acct@active",
      Clio.DefaultTimeoutMs,
      Clio.FinalityType.head
    )
    expect(res).toEqual({ transaction_id: "tx1" })
    expect(push).toHaveBeenCalledTimes(1)
    expect(inBlock).toHaveBeenCalledTimes(1)
    expect(irr).not.toHaveBeenCalled() // head finality skips the LIB wait
  })
})

describe("Clio.FinalityType", () => {
  it("maps each member to its nodeop --read-mode string value", () => {
    expect(Clio.FinalityType.speculative).toBe("speculative")
    expect(Clio.FinalityType.head).toBe("head")
    expect(Clio.FinalityType.irreversible).toBe("irreversible")
  })

  it("DefaultFinality is irreversible", () => {
    expect(Clio.DefaultFinality).toBe(Clio.FinalityType.irreversible)
  })
})

/**
 * Minimal view of the private internals the file-push path delegates to, so the
 * test can mock them without spawning clio: `run` execs the binary and
 * `assertFinality` waits for the tx to reach the requested finality.
 */
type ClioFilePushInternals = {
  run: (args: string[], opts?: { json?: boolean }) => Promise<unknown>
  assertFinality: (
    txId: string,
    label: string,
    finality: unknown,
    waitTimeoutMs: number
  ) => Promise<void>
}

describe("Clio.pushActionFileAndWait", () => {
  it("writes the action to a temp file, runs `push transaction -j`, waits for finality, then removes the file", async () => {
    const clio = makeClio()
    const internals = clio as unknown as ClioFilePushInternals
    let capturedPath = ""
    let capturedBody: unknown
    const run = jest
      .spyOn(internals, "run")
      .mockImplementation(async (args: string[]) => {
        capturedPath = args[args.length - 1]
        capturedBody = JSON.parse(Fs.readFileSync(capturedPath, "utf-8"))
        return { transaction_id: "txfile1" }
      })
    const finality = jest
      .spyOn(internals, "assertFinality")
      .mockResolvedValue(undefined)

    const res = await clio.pushActionFileAndWait(
      "sysio.roa",
      "setsyscode",
      { account: "sysio.token", code: "deadbeef" },
      "sysio@active"
    )

    expect(res).toEqual({ transaction_id: "txfile1" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      ["push", "transaction", "-j", capturedPath],
      { json: true }
    )
    // The temp file held a single-action transaction with the split @ auth.
    expect(capturedBody).toEqual({
      actions: [
        {
          account: "sysio.roa",
          name: "setsyscode",
          authorization: [{ actor: "sysio", permission: "active" }],
          data: { account: "sysio.token", code: "deadbeef" }
        }
      ]
    })
    expect(finality).toHaveBeenCalledWith(
      "txfile1",
      expect.any(String),
      expect.anything(),
      expect.anything()
    )
    // The temp file is unlinked in the finally block.
    expect(Fs.existsSync(capturedPath)).toBe(false)
  })
})

describe("ClioErrorFragment", () => {
  it("carries the chain error fragments the harness branches on", () => {
    expect(ClioErrorFragment.AccountAlreadyExists).toBe("already exists")
    expect(ClioErrorFragment.WalletAlreadyUnlocked).toBe("Already unlocked")
  })
})

describe("Clio.walletOpenAndUnlock", () => {
  it("defaults to DEFAULT_WALLET_NAME when no wallet is given", async () => {
    const clio = makeClio()
    const open = jest
      .spyOn(clio, "walletOpen")
      .mockResolvedValue(undefined as never)
    const unlock = jest
      .spyOn(clio, "walletUnlock")
      .mockResolvedValue(undefined as never)

    await clio.walletOpenAndUnlock()

    expect(open).toHaveBeenCalledWith(DEFAULT_WALLET_NAME)
    expect(unlock).toHaveBeenCalledWith(
      DEFAULT_WALLET_NAME,
      clio.walletPassword
    )
  })

  it("treats the already-unlocked rejection as benign", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "walletOpen").mockResolvedValue(undefined as never)
    jest
      .spyOn(clio, "walletUnlock")
      .mockRejectedValue(new Error("Already unlocked: default"))

    await expect(clio.walletOpenAndUnlock()).resolves.toBeUndefined()
  })

  it("rethrows any other unlock failure", async () => {
    const clio = makeClio()
    jest.spyOn(clio, "walletOpen").mockResolvedValue(undefined as never)
    jest
      .spyOn(clio, "walletUnlock")
      .mockRejectedValue(new Error("invalid password"))

    await expect(clio.walletOpenAndUnlock()).rejects.toThrow("invalid password")
  })
})
