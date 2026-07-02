/**
 * EthereumCollateralTool — Step factories for the Ethereum-outpost collateral
 * writes. Every on-chain WRITE is its OWN {@link ClusterBuildStep} so the
 * `Report` records it: {@link deposit} (native ETH), {@link withdraw} (the
 * collateral withdraw request), {@link approveErc20} (the ERC-20 allowance
 * write), {@link depositNonNative} (the ERC-20 deposit write). Each runner
 * resolves the operator identity from `ctx.keyStore`, binds the
 * `OperatorRegistry` to the operator's derived wallet, and performs exactly ONE
 * write. The contract-surface types + artifact resolution are pure value helpers
 * used INSIDE the runners; {@link readDepositedByCode} is a free READ.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { OperatorType } from "@wireio/opp-typescript-models"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import {
  ethereumCompressedPubkey,
  ethereumSigner
} from "../../utils/keyPairUtils.js"
import { Report } from "../../report/Report.js"
import { contractView, resolveLatestNonce } from "../../utils/ethereumUtils.js"

/** Positional argument tuple of `OperatorRegistry.depositNonNative(...)`. */
type DepositNonNativeArgs = [
  chainCode: bigint,
  tokenCode: bigint,
  reserveCode: bigint,
  operatorType: number,
  compressedPubkey: string | Uint8Array,
  amount: bigint,
  overrides?: ethers.Overrides
]

/** Structural surface of the `OperatorRegistry` writes this tool binds. */
export interface OperatorRegistryContract extends ethers.BaseContract {
  deposit: (
    operatorType: number,
    compressedPubkey: string | Uint8Array,
    tokenCode: bigint,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  depositNonNative: (
    ...args: DepositNonNativeArgs
  ) => Promise<ethers.ContractTransactionResponse>
  withdraw: (
    compressedPubkey: string | Uint8Array,
    tokenCode: bigint,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  depositedByCode: (operator: string, tokenCode: bigint) => Promise<bigint>
  nativeTokenCode: () => Promise<bigint>
  getAddress: () => Promise<string>
}

/** Structural surface of an ERC-20 `approve` write. */
export interface Erc20ApprovableContract extends ethers.BaseContract {
  approve: (
    spender: string,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

export namespace EthereumCollateralTool {
  // ── Step: native ETH deposit (`OperatorRegistry.deposit`) ────────────────

  /** Input for {@link deposit} — one native-ETH collateral deposit write. */
  export interface DepositInput extends StepInput {
    readonly kind: "EthereumCollateralTool.DepositInput"
    /** Operator whose identity is read from `ctx.outputs`. */
    readonly operatorAccount: string
    readonly operatorType: OperatorType
    /** 8-byte slug_name (`uint64`) of the deposited token (native `ETH`). */
    readonly tokenCode: bigint
    /** Wei to escrow — forwarded as `msg.value` for the native token. */
    readonly amount: bigint
  }

  /** A single native-ETH collateral deposit write to `OperatorRegistry.deposit(...)`. */
  export function deposit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    operatorType: OperatorType,
    tokenCode: bigint,
    amount: bigint
  ): ClusterBuildStep<C, DepositInput> {
    return ClusterBuildStep.create<C, DepositInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumCollateralTool.DepositInput",
        operatorAccount,
        operatorType,
        tokenCode,
        amount
      },
      runDeposit
    )
  }

  /** Named runner — ONE `OperatorRegistry.deposit(...)` write, signed by the operator wallet. */
  export async function runDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "EthereumCollateralTool.deposit: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const compressedPubkey = ethereumCompressedPubkey(operator.ethereum)
    Assert.ok(
      compressedPubkey.byteLength === 33,
      `EthereumCollateralTool.deposit: compressedPubkey must be 33 bytes, got ${compressedPubkey.byteLength}`
    )
    const registry = loadOperatorRegistry(ctx, ethereumSigner(operator.ethereum, ctx.ethereum.provider))
    const isNative = input.tokenCode === (await registry.nativeTokenCode())
    const nonce = await resolveLatestNonce(registry)
    const overrides: ethers.Overrides = isNative ? { value: input.amount, nonce } : { nonce }
    const response = await registry.deposit(
      input.operatorType,
      compressedPubkey,
      input.tokenCode,
      input.amount,
      overrides
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `EthereumCollateralTool.deposit: reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: collateral withdraw request (`OperatorRegistry.withdraw`) ──────

  /** Input for {@link withdraw} — one collateral withdraw-request write. */
  export interface WithdrawInput extends StepInput {
    readonly kind: "EthereumCollateralTool.WithdrawInput"
    /** Operator whose identity is resolved from `ctx.keyStore`. */
    readonly operatorAccount: string
    /** 8-byte slug_name (`uint64`) of the token to release. */
    readonly tokenCode: bigint
    /** Wei to release (must not exceed the escrowed collateral). */
    readonly amount: bigint
  }

  /**
   * A single `OperatorRegistry.withdraw(...)` write, signed by the operator's
   * ETH wallet. This is a REQUEST — the depot queues it (`sysio.opreg::
   * wtdwqueue`) and the escrow only decrements when the WITHDRAW_REMIT comes
   * back through OPP.
   */
  export function withdraw<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    tokenCode: bigint,
    amount: bigint
  ): ClusterBuildStep<C, WithdrawInput> {
    return ClusterBuildStep.create<C, WithdrawInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumCollateralTool.WithdrawInput", operatorAccount, tokenCode, amount },
      runWithdraw
    )
  }

  /** Named runner — ONE `OperatorRegistry.withdraw(...)` write. */
  export async function runWithdraw<C extends ClusterBuildContext>(
    ctx: C,
    input: WithdrawInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "EthereumCollateralTool.withdraw: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const registry = loadOperatorRegistry(ctx, ethereumSigner(operator.ethereum, ctx.ethereum.provider))
    const nonce = await resolveLatestNonce(registry)
    const response = await registry.withdraw(
      ethereumCompressedPubkey(operator.ethereum),
      input.tokenCode,
      input.amount,
      { nonce }
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `EthereumCollateralTool.withdraw: reverted (status=${receipt?.status ?? "null"})`
    )
  }

  /**
   * READ the operator's escrowed collateral for `tokenCode` (the outpost's
   * `depositedByCode` ledger, keyed by the operator's ETH address). A read —
   * executes freely inside verify steps.
   */
  export async function readDepositedByCode<C extends ClusterBuildContext>(
    ctx: C,
    operatorAccount: string,
    tokenCode: bigint
  ): Promise<bigint> {
    const operator = ctx.keyStore.assertOperator(operatorAccount)
    const registry = loadOperatorRegistry(
      ctx,
      ethereumSigner(operator.ethereum, ctx.ethereum.provider)
    )
    return registry.depositedByCode(operator.ethereum.address, tokenCode)
  }

  // ── Step: ERC-20 allowance (`approve`) ───────────────────────────────────

  /** Input for {@link approveErc20} — one ERC-20 allowance write. */
  export interface ApproveErc20Input extends StepInput {
    readonly kind: "EthereumCollateralTool.ApproveErc20Input"
    readonly operatorAccount: string
    /**
     * Mock token NAME (`"USDC"` / `"USDT"` / `"LIQETH"`) — the config-level
     * identity. Token + OperatorRegistry ADDRESSES are deploy artifacts that
     * do not exist when the step is CONSTRUCTED, so the runner resolves both.
     */
    readonly tokenName: string
    readonly amount: bigint
  }

  /** A single `ERC20.approve(OperatorRegistry, amount)` write, signed by the operator wallet. */
  export function approveErc20<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    tokenName: string,
    amount: bigint
  ): ClusterBuildStep<C, ApproveErc20Input> {
    return ClusterBuildStep.create<C, ApproveErc20Input>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumCollateralTool.ApproveErc20Input",
        operatorAccount,
        tokenName,
        amount
      },
      runApproveErc20
    )
  }

  /** Named runner — resolve token + OperatorRegistry addresses, then ONE `ERC20.approve(...)` write. */
  export async function runApproveErc20<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveErc20Input,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const tokenAddress = mockErc20Address(
      ctx.config.ethereumDeploymentsPath,
      input.tokenName
    )
    const spender = loadOutpostAddresses(
      ctx.config.ethereumDeploymentsPath
    ).OperatorRegistry
    Assert.ok(
      spender != null && /^0x[0-9a-fA-F]{40}$/.test(spender),
      `EthereumCollateralTool.approve: OperatorRegistry not in outpost-addrs.json (got ${spender})`
    )
    const erc20 = contractView<Erc20ApprovableContract>(
      tokenAddress,
      Erc20ApproveAbi,
      ethereumSigner(operator.ethereum, ctx.ethereum.provider)
    )
    const nonce = await resolveLatestNonce(erc20)
    const response = await erc20.approve(spender, input.amount, { nonce })
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `EthereumCollateralTool.approve: reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: ERC-20 deposit (`depositNonNative`) ────────────────────────────

  /** Input for {@link depositNonNative} — one ERC-20 collateral deposit write. */
  export interface DepositNonNativeInput extends StepInput {
    readonly kind: "EthereumCollateralTool.DepositNonNativeInput"
    readonly operatorAccount: string
    readonly chainCode: bigint
    readonly tokenCode: bigint
    readonly reserveCode: bigint
    readonly operatorType: OperatorType
    readonly amount: bigint
  }

  /**
   * A single `OperatorRegistry.depositNonNative(...)` write. The ERC-20 must be
   * pre-approved by an {@link approveErc20} Step earlier in the same phase.
   */
  export function depositNonNative<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    chainCode: bigint,
    tokenCode: bigint,
    reserveCode: bigint,
    operatorType: OperatorType,
    amount: bigint
  ): ClusterBuildStep<C, DepositNonNativeInput> {
    return ClusterBuildStep.create<C, DepositNonNativeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumCollateralTool.DepositNonNativeInput",
        operatorAccount,
        chainCode,
        tokenCode,
        reserveCode,
        operatorType,
        amount
      },
      runDepositNonNative
    )
  }

  /** Named runner — ONE `OperatorRegistry.depositNonNative(...)` write. */
  export async function runDepositNonNative<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositNonNativeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "EthereumCollateralTool.depositNonNative: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const registry = loadOperatorRegistry(ctx, ethereumSigner(operator.ethereum, ctx.ethereum.provider))
    const nonce = await resolveLatestNonce(registry)
    const response = await registry.depositNonNative(
      input.chainCode,
      input.tokenCode,
      input.reserveCode,
      input.operatorType,
      ethereumCompressedPubkey(operator.ethereum),
      input.amount,
      { nonce }
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `EthereumCollateralTool.depositNonNative: reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── value helpers (reads / artifact loads — executed INSIDE runners) ─────

  /** Minimal ERC-20 ABI for the `approve` write. */
  const Erc20ApproveAbi: ethers.InterfaceAbi = [
    "function approve(address spender, uint256 amount) returns (bool)"
  ]

  /**
   * Resolve the `OperatorRegistry` contract from the run's deploy artifacts,
   * bound to `wallet`. Address from THIS cluster's deployments dir
   * (`ClusterConfig.ethereumDeploymentsPath`); ABI from the hardhat artifact.
   */
  export function loadOperatorRegistry<C extends ClusterBuildContext>(
    ctx: C,
    wallet: ethers.Signer
  ): OperatorRegistryContract {
    const address = loadOutpostAddresses(
      ctx.config.ethereumDeploymentsPath
    ).OperatorRegistry
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `EthereumCollateralTool: OperatorRegistry not in outpost-addrs.json (got ${address})`
    )
    const abi = loadOutpostAbi(ctx.config.ethereumPath, "OperatorRegistry")
    return contractView<OperatorRegistryContract>(address, abi, wallet)
  }

  /**
   * Read the outpost deploy-address map from THIS cluster's deployments dir
   * (`ClusterConfig.ethereumDeploymentsPath` — per-run, parallel-safe).
   */
  export function loadOutpostAddresses(deploymentsPath: string): Record<string, string> {
    const addressesPath = Path.join(deploymentsPath, "outpost-addrs.json")
    Assert.ok(
      Fs.existsSync(addressesPath),
      `EthereumCollateralTool: outpost addresses not found at ${addressesPath}`
    )
    return JSON.parse(Fs.readFileSync(addressesPath, "utf8"))
  }

  /**
   * Resolve a mock ERC-20's deployed address by token NAME from THIS cluster's
   * deploy artifacts. Runners call this at RUN time — the address does not
   * exist when steps are constructed (the outpost deploys later in the same
   * build), and a configured collateral leg whose mock is missing is a hard
   * failure, never a silent skip.
   */
  export function mockErc20Address(
    deploymentsPath: string,
    tokenName: string
  ): string {
    const addresses = loadOutpostAddresses(deploymentsPath),
      address = match(tokenName)
        .with("USDC", () => addresses.MockUsdc)
        .with("USDT", () => addresses.MockUsdt)
        .with(
          "LIQETH",
          () => addresses.LiqEth ?? addresses.LiqETH ?? addresses.LiqEthToken
        )
        .otherwise(() => null)
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `EthereumCollateralTool: no deployed mock ERC-20 for ${tokenName} ` +
        `(outpost-addrs.json keys: ${Object.keys(addresses).join(", ")})`
    )
    return address
  }

  /** Read a hardhat-built ABI for an outpost contract by name. */
  export function loadOutpostAbi(
    ethereumPath: string,
    contractName: string
  ): ethers.InterfaceAbi {
    const artifactPath = Path.join(
      ethereumPath,
      "artifacts",
      "contracts",
      "outpost",
      `${contractName}.sol`,
      `${contractName}.json`
    )
    Assert.ok(
      Fs.existsSync(artifactPath),
      `EthereumCollateralTool: ABI artifact not found at ${artifactPath}`
    )
    return JSON.parse(Fs.readFileSync(artifactPath, "utf8")).abi
  }
}
