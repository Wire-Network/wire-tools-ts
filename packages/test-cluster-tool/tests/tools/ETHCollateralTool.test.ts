import "jest"
import {
  depositETHNonNativeCollateral,
  type Erc20ApprovableContract,
  type OperatorRegistryDepositNonNativeContract
} from "@wireio/test-cluster-tool"
import { OperatorType } from "@wireio/opp-typescript-models"

/**
 * Unit coverage for `depositETHNonNativeCollateral`'s staticCall-guarded retry
 * (PR #11). The helper dry-runs `OperatorRegistry.depositNonNative` with
 * `.staticCall` before each send, retries a transient revert with backoff, and
 * — if the revert persists across every attempt — throws the DECODED
 * `require(cond, "msg")` reason instead of letting a reasonless status-0
 * receipt surface as an opaque CALL_EXCEPTION. These tests drive the three
 * branches (clean / transient-then-clean / persistent) plus input validation
 * against structural mocks, so they need no live anvil.
 */

const OP_REG_ADDR = "0x00000000000000000000000000000000000000aa"
const ERC20_ADDR = "0x00000000000000000000000000000000000000bb"
const SIGNER_ADDR = "0x00000000000000000000000000000000000000cc"

const CHAIN = 1n
const TOKEN = 2n
const RESERVE = 3n
const AMOUNT = 1000n
const PUBKEY = new Uint8Array(33).fill(2)

/** Minimal mined-receipt-bearing tx response (`tx.wait(1) -> { status }`). */
function txResponse(status: number) {
  return { wait: jest.fn(async () => ({ status })) }
}

/** A runner satisfying `resolveLatestNonce` (a signer with a provider). */
function makeRunner() {
  return {
    getAddress: async () => SIGNER_ADDR,
    provider: { getTransactionCount: async () => 0 }
  }
}

/**
 * Structural `OperatorRegistry` mock whose `depositNonNative` is both callable
 * (the send) and carries a `.staticCall` (the dry-run) — exactly the surface
 * the helper now declares in `OperatorRegistryDepositNonNativeContract`. A mock
 * that omitted `.staticCall` would fail to compile, which is the whole point of
 * the interface change.
 */
function makeOpReg(
  staticCall: jest.Mock,
  depositNonNative: jest.Mock = jest.fn(async () => txResponse(1))
): OperatorRegistryDepositNonNativeContract {
  const method = depositNonNative as unknown as { staticCall: jest.Mock }
  method.staticCall = staticCall
  return {
    depositNonNative,
    getAddress: jest.fn(async () => OP_REG_ADDR),
    runner: makeRunner()
  } as unknown as OperatorRegistryDepositNonNativeContract
}

/** Structural ERC-20 mock the helper pre-approves before depositing. */
function makeErc20(): Erc20ApprovableContract {
  return {
    approve: jest.fn(async () => txResponse(1)),
    getAddress: jest.fn(async () => ERC20_ADDR),
    runner: makeRunner()
  } as unknown as Erc20ApprovableContract
}

describe("depositETHNonNativeCollateral — staticCall-guarded retry", () => {
  test("clean dry-run approves, dry-runs, submits once, returns the receipt", async () => {
    const staticCall = jest.fn(async () => undefined)
    const depositNonNative = jest.fn(async () => txResponse(1))
    const opReg = makeOpReg(staticCall, depositNonNative)
    const erc20 = makeErc20()

    const receipt = await depositETHNonNativeCollateral(
      opReg,
      erc20,
      CHAIN,
      TOKEN,
      RESERVE,
      OperatorType.UNDERWRITER,
      PUBKEY,
      AMOUNT
    )

    expect(receipt.status).toBe(1)
    expect(erc20.approve).toHaveBeenCalledTimes(1)
    expect(staticCall).toHaveBeenCalledTimes(1)
    // The dry-run carries the deposit args verbatim, with no tx overrides.
    expect(staticCall).toHaveBeenCalledWith(
      CHAIN,
      TOKEN,
      RESERVE,
      OperatorType.UNDERWRITER,
      PUBKEY,
      AMOUNT
    )
    expect(depositNonNative).toHaveBeenCalledTimes(1)
    // The real send forwards the same args plus a resolved nonce.
    expect(depositNonNative).toHaveBeenCalledWith(
      CHAIN,
      TOKEN,
      RESERVE,
      OperatorType.UNDERWRITER,
      PUBKEY,
      AMOUNT,
      expect.objectContaining({ nonce: expect.anything() })
    )
  })

  test("transient dry-run revert retries with backoff, then submits on the clean attempt", async () => {
    jest.useFakeTimers()
    try {
      const staticCall = jest
        .fn()
        .mockRejectedValueOnce({ reason: "stale OperatorRegistry storage" })
        .mockResolvedValueOnce(undefined)
      const depositNonNative = jest.fn(async () => txResponse(1))
      const opReg = makeOpReg(staticCall, depositNonNative)
      const erc20 = makeErc20()

      const pending = depositETHNonNativeCollateral(
        opReg,
        erc20,
        CHAIN,
        TOKEN,
        RESERVE,
        OperatorType.UNDERWRITER,
        PUBKEY,
        AMOUNT
      )
      // Drive past the (500ms, then 1000ms) backoff schedule.
      await jest.advanceTimersByTimeAsync(2000)
      const receipt = await pending

      expect(receipt.status).toBe(1)
      expect(staticCall).toHaveBeenCalledTimes(2)
      // The send happens only AFTER a clean dry-run — never on the reverted one.
      expect(depositNonNative).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test("persistent dry-run revert throws the decoded reason and never submits", async () => {
    jest.useFakeTimers()
    try {
      const staticCall = jest
        .fn()
        .mockRejectedValue({ reason: "token not tracked" })
      const depositNonNative = jest.fn(async () => txResponse(1))
      const opReg = makeOpReg(staticCall, depositNonNative)
      const erc20 = makeErc20()

      const pending = depositETHNonNativeCollateral(
        opReg,
        erc20,
        CHAIN,
        TOKEN,
        RESERVE,
        OperatorType.UNDERWRITER,
        PUBKEY,
        AMOUNT
      )
      // Attach the rejection handler before advancing so the failure the timers
      // drive is never an unhandled rejection.
      const expectation = expect(pending).rejects.toThrow("token not tracked")
      await jest.advanceTimersByTimeAsync(2000)
      await expectation

      expect(staticCall).toHaveBeenCalledTimes(3)
      expect(depositNonNative).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test("rejects a non-positive amount before touching the chain", async () => {
    const staticCall = jest.fn()
    const opReg = makeOpReg(staticCall)
    const erc20 = makeErc20()

    await expect(
      depositETHNonNativeCollateral(
        opReg,
        erc20,
        CHAIN,
        TOKEN,
        RESERVE,
        OperatorType.UNDERWRITER,
        PUBKEY,
        0n
      )
    ).rejects.toThrow("amount must be positive")
    expect(erc20.approve).not.toHaveBeenCalled()
    expect(staticCall).not.toHaveBeenCalled()
  })

  test("rejects a compressed pubkey that is not 33 bytes", async () => {
    const staticCall = jest.fn()
    const opReg = makeOpReg(staticCall)
    const erc20 = makeErc20()

    await expect(
      depositETHNonNativeCollateral(
        opReg,
        erc20,
        CHAIN,
        TOKEN,
        RESERVE,
        OperatorType.UNDERWRITER,
        new Uint8Array(32),
        AMOUNT
      )
    ).rejects.toThrow("compressedPubkey must be 33 bytes")
    expect(staticCall).not.toHaveBeenCalled()
  })
})
