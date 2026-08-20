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
  return new ethers.Contract(address, abi, runner) as View & ethers.BaseContract
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
 *
 * The value is the PROMISE of the next nonce, not the number, and that is
 * load-bearing. Seeding needs a `getTransactionCount` round-trip, so a
 * number-valued counter leaves a read-modify-write straddling an `await`:
 * every caller that arrives while the seed is in flight finds an empty cache,
 * issues its own read, and receives the SAME value. Storing the promise lets
 * each caller take its link synchronously — it reads the current tail and
 * installs `tail + 1` before it yields — so concurrent callers cannot collide.
 * (Measured 2026-08-10: nonce 157 went to four parallel funding sends; three
 * were rejected `nonce has already been used`.)
 */
const nonceCounters = new Map<string, Promise<number>>()

/**
 * What a nonce is drawn for: a contract bound to a signer, or the signer
 * itself. Both forms exist because not every same-signer write goes through a
 * contract — a plain value transfer is `signer.sendTransaction(...)` with no
 * contract in sight, and it MUST draw from the SAME per-address counter.
 */
export type NonceSource = ethers.BaseContract | ethers.Signer

/**
 * The signer behind a {@link NonceSource}, asserted able to sign and reach a
 * chain.
 *
 * Discriminates on `runner`, NOT on `getAddress`: in ethers v6 a
 * `BaseContract` ALSO exposes `getAddress()` (it returns the contract's own
 * address), so a `getAddress`-based check would classify every contract as a
 * signer and draw the nonce for the wrong address.
 */
function assertNonceSigner(source: NonceSource): ethers.Signer {
  const signer = "runner" in source ? (source.runner as ethers.Signer) : source
  Assert.ok(
    signer != null && typeof signer.getAddress === "function",
    "resolveLatestNonce: contract must be bound to a Signer (got runner without getAddress)"
  )
  Assert.ok(signer.provider !== null, "resolveLatestNonce: signer must have a Provider attached")
  return signer
}

/**
 * Resolve the next nonce to submit for `source`'s signer.
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
 * @param source Contract bound to a Signer, or the Signer itself; either way
 *               it must resolve to a Signer with a Provider.
 * @return The next nonce to submit.
 * @throws If the source resolves to no Signer, or that Signer has no Provider.
 */
export async function resolveLatestNonce(source: NonceSource): Promise<number> {
  const signer = assertNonceSigner(source)
  const provider = signer.provider
  const fromAddr = (await signer.getAddress()).toLowerCase()

  // Take this call's link and install the next one SYNCHRONOUSLY — no `await`
  // between the read and the write, so two callers can never take the same one.
  const nonce = nonceCounters.get(fromAddr) ?? provider.getTransactionCount(fromAddr, "latest")
  nonceCounters.set(
    fromAddr,
    nonce.then(value => value + 1)
  )
  // A failed SEED must not poison every later caller with the same rejection:
  // drop the chain so the next call re-seeds from the chain itself. The
  // rejection still reaches THIS caller through the returned promise.
  nonce.catch(() => nonceCounters.delete(fromAddr))
  return nonce
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
