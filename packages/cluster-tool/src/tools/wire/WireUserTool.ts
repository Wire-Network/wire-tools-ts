import Assert from "node:assert"

import { getLogger, NestedError } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"

import { WireClient } from "../../clients/wire/WireClient.js"
import { ClioRunner } from "../../clients/wire/clio/ClioRunner.js"
import { Constants } from "../../Constants.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"

const log = getLogger(__filename)

/**
 * Options for {@link provisionWireUser}.
 */
export interface WireUserOptions {
  /**
   * Raw WIRE base-units (9 decimals) to fund the account with from the
   * `sysio` treasury. `0n` creates the account without funding (e.g. a
   * swap-to-WIRE recipient that only needs to exist).
   */
  fundWireAmount?: bigint
}

/** Result of {@link provisionWireUser}. */
export interface WireUser {
  /** The WIRE account name (1..12 chars, base32 alphabet). */
  account: string
  /**
   * The account name's string-spelling bytes — the canonical
   * `ChainAddress.address` encoding for `CHAIN_KIND_WIRE` recipients
   * (what a swap-to-WIRE `targetRecipient` carries).
   */
  accountBytes: Uint8Array
}

/** Format raw 9-decimal WIRE base units as a sysio asset string. */
export function formatWireAsset(rawAmount: bigint): string {
  const whole = rawAmount / 1_000_000_000n
  const frac = (rawAmount % 1_000_000_000n).toString().padStart(9, "0")
  return `${whole}.${frac} WIRE`
}

/**
 * Provision a WIRE user account for a flow scenario: create the account
 * under the dev K1 key (idempotent across re-runs), attach the standard
 * resource policy from the bootstrap node owner, and optionally fund it
 * with WIRE from the `sysio` treasury.
 *
 * This is flow-layer provisioning (composed from a flow's `beforeAll`),
 * shared here because the WIRE-endpoint swap flows (to-WIRE recipient,
 * from-WIRE depositor, reserve matcher/owner) all need the same shape.
 *
 * @param wire    The cluster's WIRE client (wallet must hold the dev key —
 *                true for every harness-bootstrapped cluster).
 * @param account WIRE account name to provision.
 * @param options Funding options.
 * @return The provisioned account + its ChainAddress byte encoding.
 */
export async function provisionWireUser(
  wire: WireClient,
  account: string,
  options: WireUserOptions = {}
): Promise<WireUser> {
  const { fundWireAmount = 0n } = options

  await createWireUserAccount(wire, account)
  await addWireUserResourcePolicy(wire, account)

  if (fundWireAmount > 0n) {
    await fundWireUser(wire, account, fundWireAmount)
  }

  return wireUser(account)
}

/** Atomic Step factories for provisioning a flow-owned WIRE user. */
export namespace WireUserTool {
  /** Input for one idempotent WIRE account-creation write. */
  export interface CreateAccountInput extends StepInput {
    readonly kind: "WireUserTool.CreateAccountInput"
    readonly account: string
  }

  /** Input for one WIRE resource-policy write. */
  export interface AddResourcePolicyInput extends StepInput {
    readonly kind: "WireUserTool.AddResourcePolicyInput"
    readonly account: string
  }

  /** Input for one treasury-to-user WIRE transfer. */
  export interface FundInput extends StepInput {
    readonly kind: "WireUserTool.FundInput"
    readonly account: string
    readonly amount: bigint
  }

  /**
   * Typed output for a flow-owned WIRE user.
   *
   * @param account - Account name used to namespace the output.
   * @returns Typed user output key.
   */
  export function userOutputKey(account: string): OutputKey<WireUser> {
    return outputKey<WireUser>(
      `wireUser.${account}`,
      `WIRE flow user ${account}`
    )
  }

  /**
   * Plan one idempotent account-creation write.
   *
   * @param actor - Narrative subject.
   * @param name - Report step name.
   * @param description - Report step description.
   * @param options - Step tuning.
   * @param account - Account to create under the development key.
   * @returns Account-creation Step.
   */
  export function planAccountCreation<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, CreateAccountInput> {
    return ClusterBuildStep.create<C, CreateAccountInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireUserTool.CreateAccountInput", account },
      runAccountCreation
    )
  }

  /** Named runner for one account-creation write. */
  export async function runAccountCreation<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateAccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await createWireUserAccount(ctx.wire, input.account)
    ctx.outputs.set(userOutputKey(input.account), wireUser(input.account))
  }

  /**
   * Plan one resource-policy write.
   *
   * @param actor - Narrative subject.
   * @param name - Report step name.
   * @param description - Report step description.
   * @param options - Step tuning.
   * @param account - Existing account receiving the policy.
   * @returns Resource-policy Step.
   */
  export function planResourcePolicy<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, AddResourcePolicyInput> {
    return ClusterBuildStep.create<C, AddResourcePolicyInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireUserTool.AddResourcePolicyInput", account },
      runResourcePolicy
    )
  }

  /** Named runner for one resource-policy write. */
  export async function runResourcePolicy<C extends ClusterBuildContext>(
    ctx: C,
    input: AddResourcePolicyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await addWireUserResourcePolicy(ctx.wire, input.account)
  }

  /**
   * Plan one treasury funding transfer.
   *
   * @param actor - Narrative subject.
   * @param name - Report step name.
   * @param description - Report step description.
   * @param options - Step tuning.
   * @param account - Transfer recipient.
   * @param amount - Raw 9-decimal WIRE base units.
   * @returns Treasury funding Step.
   */
  export function planFunding<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    amount: bigint
  ): ClusterBuildStep<C, FundInput> {
    return ClusterBuildStep.create<C, FundInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireUserTool.FundInput", account, amount },
      runFunding
    )
  }

  /** Named runner for one treasury funding transfer. */
  export async function runFunding<C extends ClusterBuildContext>(
    ctx: C,
    input: FundInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "WireUserTool funding must be positive")
    await fundWireUser(ctx.wire, input.account, input.amount)
  }
}

function wireUser(account: string): WireUser {
  return { account, accountBytes: new TextEncoder().encode(account) }
}

async function createWireUserAccount(
  wire: WireClient,
  account: string
): Promise<void> {
  await wire.wallet.unlock()
  try {
    await wire.createAccount(
      "sysio",
      account,
      Constants.DEV_K1_PUBLIC_KEY,
      Constants.DEV_K1_PUBLIC_KEY
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(ClioRunner.ErrorFragment.AccountAlreadyExists)) {
      throw new NestedError(
        `provisionWireUser: createAccount(${account}) failed`,
        { cause: err }
      )
    }
    log.debug(`provisionWireUser: account ${account} already exists — reusing`)
  }
}

async function addWireUserResourcePolicy(
  wire: WireClient,
  account: string
): Promise<void> {
  await wire.invoke<SysioContracts.SysioRoaAddpolicyAction>(
    "sysio.roa",
    "addpolicy",
    {
      owner: account,
      issuer: Constants.BOOTSTRAP_NODE_OWNER,
      net_weight: "25.0000 SYS",
      ram_weight: "25.0000 SYS",
      cpu_weight: "25.0000 SYS",
      time_block: 0,
      network_gen: 0
    },
    [{ actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }]
  )
}

async function fundWireUser(
  wire: WireClient,
  account: string,
  amount: bigint
): Promise<void> {
  const quantity = formatWireAsset(amount)
  await wire.invoke<SysioContracts.SysioTokenTransferAction>(
    "sysio.token",
    "transfer",
    {
      from: "sysio",
      to: account,
      quantity,
      memo: "flow WIRE user funding"
    },
    [{ actor: "sysio", permission: "active" }]
  )
  log.info(`[WireUserTool] funded ${account} with ${quantity}`)
}
