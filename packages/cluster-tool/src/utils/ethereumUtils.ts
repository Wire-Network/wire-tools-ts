import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"

/**
 * The ONE sanctioned ethers typed-view boundary: construct an
 * `ethers.Contract` and present it as the hand-declared view interface
 * `View`. The runtime object IS an ethers Contract (its methods are ABI-driven
 * proxies); `View` just names the typed subset the harness calls. The
 * intersection with `ethers.BaseContract` keeps the instance assignable to
 * BaseContract consumers ({@link resolveLatestNonce}) with no re-cast — every
 * scattered per-contract `new ethers.Contract(...)` assertion collapses into
 * this single cast site.
 *
 * @param address - Deployed contract address.
 * @param abi - Contract ABI (hardhat artifact `abi` or a fragment list).
 * @param runner - Signer or provider the calls run against.
 * @returns The contract, typed as the view + BaseContract.
 */
export function contractView<View extends object>(
  address: string,
  abi: ethers.InterfaceAbi,
  runner: ethers.ContractRunner
): View & ethers.BaseContract {
  return new ethers.Contract(address, abi, runner) as View &
    ethers.BaseContract
}

/** Shape of a deployed 20-byte EVM address (`0x` + 40 hex chars). */
export const EvmAddressPattern = /^0x[0-9a-fA-F]{40}$/

/**
 * Load a deployed outpost contract from the run's wire-ethereum deploy
 * artifacts: resolve its address from the `outpost-addrs.json` map (written by
 * `deployLocal.ts`), read the hardhat-emitted ABI artifact under
 * `<ethereumPath>/artifacts/contracts/<...artifactSubpath>/<contractName>.sol/
 * <contractName>.json`, and bind it to `signer` via {@link contractView}. The
 * ONE artifact-loading path every per-contract loader (`loadBar`,
 * `loadMockWireNodes`, `loadMockYieldEmitter`, …) delegates to.
 *
 * @param ethereumPath - The wire-ethereum repo root (artifact tree parent).
 * @param outpostAddrs - The `outpost-addrs.json` address map.
 * @param contractName - The contract's name — its `outpostAddrs` key AND its `<Name>.sol/<Name>.json` artifact basename.
 * @param artifactSubpath - Directory segments under `artifacts/contracts` holding the contract's artifact dir.
 * @param signer - Signer the returned surface is bound to.
 * @returns The signer-bound contract surface, typed as `View`.
 */
export function loadOutpostContract<View extends object>(
  ethereumPath: string,
  outpostAddrs: Record<string, string>,
  contractName: string,
  artifactSubpath: string[],
  signer: ethers.Signer
): View & ethers.BaseContract {
  const addr = outpostAddrs[contractName]
  Assert.ok(
    addr && EvmAddressPattern.test(addr),
    `loadOutpostContract: ${contractName} not in outpost-addrs.json (got ${addr}). ` +
      `Did wire-ethereum's deployLocal.ts run with the contract enabled?`
  )

  const artifactPath = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    ...artifactSubpath,
    `${contractName}.sol`,
    `${contractName}.json`
  )
  Assert.ok(
    Fs.existsSync(artifactPath),
    `loadOutpostContract: artifact not found at ${artifactPath}. ` +
      `Run \`npx hardhat compile\` in wire-ethereum first.`
  )
  const artifact = JSON.parse(Fs.readFileSync(artifactPath, "utf-8"))
  return contractView<View>(addr, artifact.abi, signer)
}

/**
 * In-process per-address nonce counters. Keyed by lowercase EVM address so a
 * burst of same-signer submissions can be sequenced without round-tripping
 * `getTransactionCount` for every tx (which lags behind un-mined submissions
 * and hands back a stale value → `nonce too low`). Shared module state by
 * design — every {@link resolveLatestNonce} caller for a given address draws
 * from the same counter.
 */
const nonceCounters = new Map<string, number>()

/**
 * Resolve the next nonce to submit from `contract`'s bound signer.
 *
 * First call per address seeds from `getTransactionCount(addr, "latest")`;
 * subsequent calls increment the cached counter. Caller MUST pass the
 * returned value as the `nonce` field of the tx `Overrides` object AND
 * await `tx.wait(1)` (or higher) before issuing the next call from the
 * same signer — the cached counter is only valid if every submission
 * actually lands on-chain.
 *
 * If a submission fails for a reason other than NONCE_EXPIRED (e.g. a
 * revert), the caller should call {@link clearNonceCache} so the next
 * `resolveLatestNonce` re-seeds from the chain.
 *
 * @param contract Ethers contract instance bound to a Signer (its runner
 *                 must be a Signer with a Provider).
 * @return The next nonce to submit.
 * @throws If the contract is not bound to a Signer with a Provider.
 */
export async function resolveLatestNonce(
  contract: ethers.BaseContract
): Promise<number> {
  const runner = contract.runner
  Assert.ok(
    runner !== null &&
      typeof (runner as ethers.Signer).getAddress === "function",
    "resolveLatestNonce: contract must be bound to a Signer (got runner without getAddress)"
  )
  const signer = runner as ethers.Signer
  const provider = signer.provider
  Assert.ok(
    provider !== null,
    "resolveLatestNonce: signer must have a Provider attached"
  )
  const fromAddr = (await signer.getAddress()).toLowerCase()

  const cached = nonceCounters.get(fromAddr)
  if (cached != null) {
    const nonce = cached
    nonceCounters.set(fromAddr, cached + 1)
    return nonce
  }
  const chainNonce = await provider.getTransactionCount(fromAddr, "latest")
  nonceCounters.set(fromAddr, chainNonce + 1)
  return chainNonce
}

/**
 * Reset the in-process nonce counter for `address`. Call when a tx
 * submission fails in a way that did NOT actually consume the nonce
 * (e.g. a pre-broadcast revert) so the next submission re-seeds from
 * the chain instead of skipping ahead.
 *
 * @param address EVM address whose counter to clear (case-insensitive).
 */
export function clearNonceCache(address: string): void {
  nonceCounters.delete(address.toLowerCase())
}

/**
 * The reason-bearing fields an `ethers` (or arbitrary) error may carry, read
 * duck-typed by {@link ethereumRevertReason}: ethers fills `reason` from a
 * decoded `require(cond, "msg")` and `shortMessage` from its own error
 * taxonomy. All optional — an arbitrary thrown value carries none of them.
 */
export interface EthereumRevertError {
  reason?: string
  shortMessage?: string
  message?: string
}

/**
 * `ethers` call overrides whose native value (`msg.value`) is a `bigint` — the
 * harness's canonical amount shape, narrowed from ethers' own
 * `BigNumberish`-widened `value`. Optional here;
 * {@link EthereumPayableOverrides} requires it.
 */
export interface EthereumValueOverrides extends ethers.Overrides {
  value?: bigint
}

/** {@link EthereumValueOverrides} for a call that MUST send native value. */
export interface EthereumPayableOverrides extends EthereumValueOverrides {
  value: bigint
}

/**
 * The most specific human-readable reason an ethers error carries: the decoded
 * `require(cond, "msg")` `reason` when present, else ethers' `shortMessage`,
 * else the plain `message`, else the stringified error. Use when surfacing a
 * revert from a `staticCall` dry-run — a mined status-0 receipt carries no
 * reason, so the dry-run's decode is the only reason a report will ever show.
 *
 * @param error - The caught ethers (or arbitrary) error.
 * @returns The best available reason string.
 */
export function ethereumRevertReason(error: unknown): string {
  const decoded = error as EthereumRevertError
  return decoded?.reason ?? decoded?.shortMessage ?? decoded?.message ?? String(error)
}
