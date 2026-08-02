/**
 * Erc20FundingTool — test-cluster helpers for funding user wallets with
 * mock ERC-20 balances and signing EIP-2612 permits.
 *
 * The harness's `ETHBootstrapper` deploys `MockUsdc`, `MockUsdt`, and
 * `MockUsdtFeeOnTransfer` as part of the local cluster spin-up; both
 * mocks expose an ungated `mint(address, uint256)` for test funding.
 * This module is the thin wrapper around those mocks.
 *
 * Production deployments never run this code — they consume the
 * canonical mainnet USDC / USDT contracts and fund users through
 * normal exchange flows.
 *
 * @see wire-ethereum/contracts/test/outpost/MockUsdc.sol
 * @see wire-ethereum/contracts/test/outpost/MockUsdt.sol
 */

import Assert from "node:assert"
import { ethers } from "ethers"

import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import { contractView, resolveLatestNonce } from "../../utils/ethereumUtils.js"
import { ethereumSigner } from "../../utils/keyPairUtils.js"
import { EthereumCollateralTool } from "./EthereumCollateralTool.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"

/**
 * Minimal structural surface for an ERC-20 mock that exposes
 * `mint(to, amount)`. All test mocks under `contracts/test/outpost/`
 * conform to this shape; `MockLiqETH`, `MockUsdc`, `MockUsdt`, and
 * `MockUsdtFeeOnTransfer` all carry the same `mint` signature.
 */
export interface MintableErc20 extends ethers.BaseContract {
  mint: (
    to: string,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

/**
 * Mint `amount` of `mockErc20` to `recipient`. Confirms via `tx.wait()`.
 *
 * Resolves the runner's `pending` nonce explicitly and passes it as an
 * `Overrides` field. ethers v6's auto-nonce population has surfaced
 * intermittent NONCE_EXPIRED rejections from anvil when two `.mint(...)`
 * calls are awaited back-to-back from the same `Wallet` instance — the
 * second call re-fetches the count *before* anvil has marked the first
 * tx as broadcast, so both txs encode the same nonce. Resolving the
 * nonce ourselves and waiting on `tx.wait()` between calls makes the
 * sequencing explicit and deterministic.
 *
 * @param mockErc20 Mock ERC-20 with an ungated `mint(to, amount)` method.
 *                  Must be bound to a signer that holds the (ungated)
 *                  mint capability.
 * @param recipient EVM address of the user to fund.
 * @param amount    Token units to mint (chain-native base units —
 *                  6-decimal for USDC/USDT, 18-decimal for LIQETH).
 * @return Mined transaction hash.
 * @throws If the tx reverts or the receipt status is non-1.
 */
export async function mintMockErc20ToUser(
  mockErc20: MintableErc20,
  recipient: string,
  amount: bigint
): Promise<string> {
  Assert.ok(
    ethers.isAddress(recipient),
    `Erc20FundingTool: recipient is not a valid address: ${recipient}`
  )
  Assert.ok(amount > 0n, "Erc20FundingTool: mint amount must be > 0")

  const nonce = await resolveLatestNonce(mockErc20)
  const tx = await mockErc20.mint(recipient, amount, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1 && receipt.blockNumber > 0,
    `Erc20FundingTool: mint tx not confirmed (status=${receipt?.status ?? "null"})`
  )
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `Erc20FundingTool: mint tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt.hash
}

/**
 * Minimal structural surface for an ERC-20 implementing
 * EIP-2612 (`name() / nonces(owner) / DOMAIN_SEPARATOR()` plus the
 * standard `permit` ABI). All `MockUsdc`-style mocks conform; mainnet
 * USDC does too. `MockUsdt` (no permit) does NOT — callers MUST use
 * the approval path for it.
 */
export interface Erc20PermitTarget extends ethers.BaseContract {
  /** Token `name()` — used as the EIP-712 domain `name`. */
  name: () => Promise<string>
  /** Current permit nonce for `owner`. */
  nonces: (owner: string) => Promise<bigint>
  /** Contract address (typed as `getAddress()` on ethers contracts). */
  getAddress: () => Promise<string>
}

/**
 * EIP-2612 permit signature components, ready to pass into
 * `ReserveManager.requestSwapErc20WithPermit` /
 * `requestReserveCreateErc20WithPermit` as the `PermitSig` struct.
 */
export interface PermitSignature {
  deadline: bigint
  v: number
  r: string
  s: string
}

/**
 * Produce a signed EIP-2612 permit for `owner` granting `spender`
 * approval to transfer `value` units of `token` until `deadline`.
 *
 * @param owner    Signer that holds the tokens — its private key signs
 *                  the typed-data payload.
 * @param token    Contract exposing `name()` + `nonces(owner)` +
 *                  `getAddress()`. Must be EIP-2612 compatible.
 * @param spender  Address that will be approved (typically
 *                  `ReserveManager`).
 * @param value    Token units to approve (chain-native base units).
 * @param deadline Unix-second deadline beyond which the permit is
 *                  invalid. Pass `BigInt(Math.floor(Date.now()/1000) + 3600)`
 *                  for a one-hour window.
 * @return `(deadline, v, r, s)` ready to pack into a `PermitSig` struct.
 */
export async function signErc20Permit(
  owner: ethers.Signer,
  token: Erc20PermitTarget,
  spender: string,
  value: bigint,
  deadline: bigint
): Promise<PermitSignature> {
  Assert.ok(
    ethers.isAddress(spender),
    `Erc20FundingTool: spender is not a valid address: ${spender}`
  )
  Assert.ok(value > 0n, "Erc20FundingTool: permit value must be > 0")
  Assert.ok(deadline > 0n, "Erc20FundingTool: permit deadline must be > 0")

  const provider = owner.provider
  Assert.ok(provider !== null, "Erc20FundingTool: owner signer has no provider")

  const ownerAddr = await owner.getAddress()
  const [network, nonce, name, tokenAddr] = await Promise.all([
    provider.getNetwork(),
    token.nonces(ownerAddr),
    token.name(),
    token.getAddress()
  ])

  const signature = await owner.signTypedData(
    {
      name,
      version: "1",
      chainId: network.chainId,
      verifyingContract: tokenAddr
    },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    {
      owner: ownerAddr,
      spender,
      value,
      nonce,
      deadline
    }
  )
  const split = ethers.Signature.from(signature)
  return {
    deadline,
    v: split.v,
    r: split.r,
    s: split.s
  }
}

/**
 * Minimal ABI to balance-check + self-mint a mock ERC-20 for collateral funding.
 * The mocks under `contracts/test/outpost/` expose an ungated `mint(to, amount)`,
 * so an operator wallet can mint itself the balance it will `approve` + deposit.
 */
const MintWithBalanceAbi: ethers.InterfaceAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)"
]

/**
 * EthereumFundingTool — Step factories for the mock-token funding WRITES the
 * underwriter collateral flow needs before an ERC-20 `depositNonNative`. Every
 * WRITE is its OWN {@link ClusterBuildStep} so the `Report` records it; the
 * runner reads the operator identity from `ctx.outputs` and performs exactly ONE
 * mint. The plain `mintMockErc20ToUser` / `signErc20Permit` helpers above stay
 * flow-layer utilities (they take a pre-bound contract / signer).
 */
export namespace EthereumFundingTool {
  /** Input for {@link planErc20Mint} — one mock-ERC-20 self-mint to the operator wallet. */
  export interface MintErc20Input extends StepInput {
    readonly kind: "EthereumFundingTool.MintErc20Input"
    /** Operator whose ETH wallet is read from `ctx.outputs` and self-mints. */
    readonly operatorAccount: string
    /**
     * Mock token NAME (`"USDC"` / `"USDT"` / `"LIQETH"`) — the config-level
     * identity. The contract ADDRESS is a deploy artifact that does not exist
     * when the step is CONSTRUCTED (the outpost deploys later in the same
     * build), so the runner resolves it at run time.
     */
    readonly tokenName: string
    /** Token base units to bring the wallet's balance up to. */
    readonly amount: bigint
  }

  /**
   * A single mock-ERC-20 self-mint, topping the operator wallet up to `amount`.
   * The operator's ETH wallet is read from `ctx.outputs` (self-mints via the mock's
   * ungated `mint`); idempotent — a wallet already at/above `amount` no-ops.
   */
  export function planErc20Mint<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    tokenName: string,
    amount: bigint
  ): ClusterBuildStep<C, MintErc20Input> {
    return ClusterBuildStep.create<C, MintErc20Input>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumFundingTool.MintErc20Input",
        operatorAccount,
        tokenName,
        amount
      },
      runErc20Mint
    )
  }

  /** Named runner — resolve the mock's deployed address, read the balance, then
   *  ONE `mint(...)` of the shortfall. */
  export async function runErc20Mint<C extends ClusterBuildContext>(
    ctx: C,
    input: MintErc20Input,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amount > 0n,
      "EthereumFundingTool.planErc20Mint: amount must be positive"
    )
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const signer = ethereumSigner(operator.ethereum, ctx.ethereum.provider)
    const tokenAddress = EthereumCollateralTool.mockErc20Address(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      input.tokenName
    )
    const token = contractView<
      MintableErc20 & { balanceOf: (address: string) => Promise<bigint> }
    >(tokenAddress, MintWithBalanceAbi, signer)
    const current = await token.balanceOf(signer.address)
    if (current >= input.amount) return
    await mintMockErc20ToUser(token, signer.address, input.amount - current)
  }
}
