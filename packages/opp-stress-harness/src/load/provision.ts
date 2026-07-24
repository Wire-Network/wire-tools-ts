import { APIClient, Name, SystemContracts } from "@wireio/sdk-core"

import { formatWireAsset, type LoadWallet, type LoadWalletKey } from "./loadWallet.js"

/** ROA contract owning account creation and resource policies. */
const RoaAccount = "sysio.roa",
  /** Action minting a `<creator>.<generated>` sub-account. */
  NewUserActionName = "newuser",
  /** Action granting the resource policy a new account needs to transact. */
  AddPolicyActionName = "addpolicy",
  /** Table recording `(nonce -> username)` per creator; scope is the creator. */
  SponsorsTable = "sponsors",
  /** Token contract for funding transfers. */
  TokenAccount = "sysio.token",
  /** Un-privileged transfer action. */
  TransferActionName = "transfer",
  /** Permission the node owner and starting wallet sign with. */
  ActivePermission = "active",
  /** Name-safe charset (no `0`, no `6-9`) for deriving nonces. */
  NonceCharset = "abcdefghijklmnopqrstuvwxyz12345",
  /** Current ROA network generation used by policy grants. */
  DefaultNetworkGen = 0,
  /** Policy time-block; 0 means no scheduled expiry. */
  DefaultTimeBlock = 0

/** Resource weights granted to each load wallet, as SYS asset strings. */
export interface LoadResourcePolicy {
  /** NET weight, e.g. `1.0000 SYS`. */
  readonly net: string
  /** CPU weight, e.g. `1.0000 SYS`. */
  readonly cpu: string
  /** RAM weight, e.g. `1.0000 SYS`. */
  readonly ram: string
}

/** Inputs for provisioning one load wallet. */
export interface ProvisionOptions {
  /** Tier-1 node owner that creates accounts and issues policies. */
  readonly nodeOwner: string
  /** Account funding the wallets; usually the node owner itself. */
  readonly funder: string
  /** Per-wallet WIRE funding in 9-decimal base units. */
  readonly fundAmount: bigint
  /** Resource weights granted per wallet. */
  readonly policy: LoadResourcePolicy
  /** Short name-safe label making this run's nonces unique and resumable. */
  readonly noncePrefix: string
}

/**
 * Derive the deterministic `newuser` nonce for one wallet index.
 *
 * The nonce is a WIRE `name` and is unique per `(creator, nonce)` on chain, so
 * it doubles as an idempotency key: re-running provisioning with the same
 * prefix will not create duplicate accounts, and the resulting account name
 * stays recoverable from the `sponsors` table.
 *
 * @param prefix Short name-safe run label.
 * @param index Wallet index.
 * @returns A name-safe nonce string.
 */
export function nonceForIndex(prefix: string, index: number): string {
  let remaining = index + 1,
    encoded = ""
  while (remaining > 0) {
    encoded = NonceCharset[(remaining - 1) % NonceCharset.length] + encoded
    remaining = Math.floor((remaining - 1) / NonceCharset.length)
  }
  const nonce = `${prefix}${encoded}`
  if (nonce.length > 12)
    throw new RangeError(`derived nonce exceeds 12 chars: ${nonce}`)
  return nonce
}

/**
 * Create one load account via `sysio.roa::newuser` and return its minted name.
 *
 * The name is chosen by the contract (seeded by block number), so it is read
 * back from the action's return value, falling back to the authoritative
 * `sponsors` table — which also makes a re-run with the same nonce recover the
 * existing account instead of failing.
 *
 * @param client Client signing as the tier-1 node owner.
 * @param options Provisioning inputs.
 * @param key Wallet key whose public key becomes the account authority.
 * @returns The minted WIRE account name.
 */
export async function createLoadAccount(
  client: APIClient,
  options: ProvisionOptions,
  key: LoadWalletKey
): Promise<string> {
  const nonce = nonceForIndex(options.noncePrefix, key.index),
    existing = await findSponsoredAccount(client, options.nodeOwner, nonce)
  if (existing !== null) return existing

  const data: SystemContracts.SysioRoaNewuserAction = {
    creator: options.nodeOwner,
    nonce,
    pubkey: key.publicKey
  }
  const result = await client.pushTransaction({
    account: RoaAccount,
    name: NewUserActionName,
    authorization: [
      { actor: options.nodeOwner, permission: ActivePermission }
    ],
    data
  })
  const minted = mintedAccountName(result)
  if (minted !== null) return minted

  const recovered = await findSponsoredAccount(client, options.nodeOwner, nonce)
  if (recovered === null)
    throw new Error(`newuser did not yield an account for nonce ${nonce}`)
  return recovered
}

/**
 * Grant a newly created account its resource policy.
 *
 * `newuser` leaves NET/CPU at zero, so without this the account cannot pay for
 * its own swap or sweep transactions.
 *
 * @param client Client signing as the node owner (the policy issuer).
 * @param options Provisioning inputs supplying the issuer and weights.
 * @param account Account receiving the policy.
 */
export async function grantResourcePolicy(
  client: APIClient,
  options: ProvisionOptions,
  account: string
): Promise<void> {
  const data: SystemContracts.SysioRoaAddpolicyAction = {
    owner: account,
    issuer: options.nodeOwner,
    net_weight: options.policy.net,
    cpu_weight: options.policy.cpu,
    ram_weight: options.policy.ram,
    time_block: DefaultTimeBlock,
    network_gen: DefaultNetworkGen
  }
  await client.pushTransaction({
    account: RoaAccount,
    name: AddPolicyActionName,
    authorization: [
      { actor: options.nodeOwner, permission: ActivePermission }
    ],
    data
  })
}

/**
 * Transfer WIRE from the funding account to a load wallet.
 *
 * Un-privileged (`require_auth(from)` only); the token contract books the
 * recipient's balance-row RAM to `sysio`, so funding costs the funder no RAM.
 *
 * @param client Client signing as the funding account.
 * @param options Provisioning inputs supplying funder and amount.
 * @param account Destination load account.
 */
export async function fundLoadAccount(
  client: APIClient,
  options: ProvisionOptions,
  account: string
): Promise<void> {
  await transferWire(
    client,
    options.funder,
    account,
    options.fundAmount,
    "opp-stress load funding"
  )
}

/**
 * Push one un-privileged `sysio.token::transfer`.
 *
 * @param client Client signing as `from`.
 * @param from Sending account.
 * @param to Receiving account.
 * @param baseUnits Amount in 9-decimal WIRE base units.
 * @param memo Transfer memo.
 */
export async function transferWire(
  client: APIClient,
  from: string,
  to: string,
  baseUnits: bigint,
  memo: string
): Promise<void> {
  const data: SystemContracts.SysioTokenTransferAction = {
    from,
    to,
    quantity: formatWireAsset(baseUnits),
    memo
  }
  await client.pushTransaction({
    account: TokenAccount,
    name: TransferActionName,
    authorization: [{ actor: from, permission: ActivePermission }],
    data
  })
}

/**
 * Provision one wallet end to end: create, grant policy, fund.
 *
 * @param client Client signing as the node owner / funder.
 * @param options Provisioning inputs.
 * @param key Generated wallet key material.
 * @returns The wallet with its provisioned account name attached.
 */
export async function provisionLoadWallet(
  client: APIClient,
  options: ProvisionOptions,
  key: LoadWalletKey
): Promise<LoadWallet> {
  const account = await createLoadAccount(client, options, key)
  await grantResourcePolicy(client, options, account)
  await fundLoadAccount(client, options, account)
  return { ...key, account }
}

/** Read a minted account name back from the `newuser` action's return value. */
function mintedAccountName(result: unknown): string | null {
  const traces = (
    result as {
      processed?: { action_traces?: readonly Record<string, unknown>[] }
    }
  ).processed?.action_traces
  if (traces === undefined) return null
  const trace = traces.find(entry => "return_value_data" in entry)
  const value = trace?.["return_value_data"]
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Look up an already-sponsored account by `(creator, nonce)`. */
async function findSponsoredAccount(
  client: APIClient,
  creator: string,
  nonce: string
): Promise<string | null> {
  const key = Name.from(nonce).value.toString()
  // Bounded KV lookup: sdk-core's typed overload demands a `type` discriminator
  // that does not apply to this raw-string bound, so normalize at the boundary.
  const result = await client.v1.chain.get_table_rows({
    code: RoaAccount,
    scope: creator,
    table: SponsorsTable,
    lower_bound: key,
    upper_bound: key,
    limit: 1,
    json: true
  } as unknown as Parameters<APIClient["v1"]["chain"]["get_table_rows"]>[0])
  const rows: readonly unknown[] =
    (result as { rows?: readonly unknown[] }).rows ?? []
  const row = rows
    .map(entry =>
      entry !== null && typeof entry === "object" && "value" in entry
        ? (entry as { value: unknown }).value
        : entry
    )
    .find(entry => entry !== null && typeof entry === "object")
  const username = (row as { username?: unknown } | undefined)?.username
  return typeof username === "string" && username.length > 0 ? username : null
}
