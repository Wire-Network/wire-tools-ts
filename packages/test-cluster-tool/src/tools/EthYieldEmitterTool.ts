/**
 * EthYieldEmitterTool — wraps `MockYieldEmitter.sol` (deployed by
 * wire-ethereum's `deployLocal.ts` script under `contracts/test/outpost/`)
 * with an ergonomic helper for the flow-yield-distribution test.
 *
 * The on-chain contract is a permissioned poke-emit fake: an admin
 * records synthetic per-staker positions, then triggers a single tx
 * that fans STAKING_REWARD attestations onto OPP's outbound queue —
 * the same queue the post-launch StakingManager will use. Once an
 * attestation lands there, the batch-operator nodeop plugin picks it
 * up, ferries it through OPP envelope consensus, and the depot
 * dispatches it as `sysio.dclaim::onreward`.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"

import { resolveLatestNonce } from "../util.js"

/**
 * Minimal `ethers` surface of `MockYieldEmitter.sol`. Typed structurally
 * so the caller can pass any compatible contract instance (typechain,
 * mock, hand-rolled stub).
 */
export interface MockYieldEmitterContract {
  setChainAndTokenCode: (
    chainCode: bigint,
    tokenCode: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  stake: (
    staker: string,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  emitYield: (
    stakers: string[],
    wireAccounts: string[],
    rewardAmounts: bigint[],
    shareBpses: number[],
    externalEpochRef: bigint,
    rewardEpochIndex: number,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  stakeOf: (staker: string) => Promise<bigint>
  totalStaked: () => Promise<bigint>
  lastExternalEpochRef: (staker: string) => Promise<bigint>
  getAddress: () => Promise<string>
}

/** Per-staker entry in an `emitYield` batch. */
export interface YieldEntry {
  /** ETH address (0x-prefixed) of the staker. */
  staker: string
  /**
   * WIRE account name the depot will credit. May be `""` for
   * not-yet-AuthEx-linked stakers — the depot then parks the reward by
   * `staker_native_address` (the ETH addr) until the link sweep moves
   * it (`sysio.dclaim::linkswept`).
   */
  wireAccount: string
  /** Reward amount in native base units (wei for ETH; the contract
   *  passes through to the depot which converts via PrecisionLib). */
  rewardAmount: bigint
  /** Informational share-in-bps for the depot's audit logging. */
  shareBps: number
}

/**
 * Load the hardhat-emitted `MockYieldEmitter.json` artifact from the
 * wire-ethereum repo, look up its deployed address from the matching
 * `outpost-addrs.json`, and return an ethers Contract instance bound
 * to `signer`. The address file is the canonical handoff the rest of
 * the harness already consumes; we read it the same way.
 */
export function loadMockYieldEmitter(
  ethereumPath: string,
  outpostAddrs: Record<string, string>,
  signer: ethers.Signer
): MockYieldEmitterContract {
  const addr = outpostAddrs.MockYieldEmitter
  Assert.ok(
    addr && /^0x[0-9a-fA-F]{40}$/.test(addr),
    `EthYieldEmitterTool: MockYieldEmitter not in outpost-addrs.json (got ${addr}). ` +
      `Did wire-ethereum's deployLocal.ts run with the contract enabled?`
  )

  const artifactPath = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    "test",
    "outpost",
    "MockYieldEmitter.sol",
    "MockYieldEmitter.json"
  )
  Assert.ok(
    Fs.existsSync(artifactPath),
    `EthYieldEmitterTool: artifact not found at ${artifactPath}. ` +
      `Run \`npx hardhat compile\` in wire-ethereum first.`
  )
  const artifact = JSON.parse(Fs.readFileSync(artifactPath, "utf-8"))
  return new ethers.Contract(addr, artifact.abi, signer) as unknown as MockYieldEmitterContract
}

/**
 * Record a stake entry on the emitter. Idempotent in the sense that
 * subsequent calls add to the staker's recorded balance.
 *
 * @param contract   Emitter bound to a signer holding the AccessManager
 *                   admin / configured role.
 * @param staker     ETH address whose stake is being recorded.
 * @param amount     Native base-unit amount to add to `staker`'s position.
 */
export async function recordStake(
  contract: MockYieldEmitterContract,
  staker: string,
  amount: bigint
): Promise<ethers.TransactionReceipt> {
  Assert.ok(amount > 0n, "EthYieldEmitterTool: stake amount must be positive")
  const nonce = await resolveLatestNonce(contract as unknown as ethers.BaseContract)
  const tx = await contract.stake(staker, amount, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthYieldEmitterTool: stake tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt
}

/**
 * Fan a batch of STAKING_REWARD attestations through OPP outbound. The
 * batch must:
 *
 *   * Be non-empty.
 *   * Use a single monotonic `externalEpochRef` across the batch — the
 *     contract enforces strict monotonicity per staker (`onreward`
 *     dedupes against this on the depot side).
 *   * Have at most one entry per staker (the contract's monotonic
 *     check would reject a same-`externalEpochRef` repeat).
 *
 * @param contract           Emitter bound to admin signer.
 * @param entries            Per-staker reward triples.
 * @param externalEpochRef   Monotonic-per-staker reference. The depot
 *                           rejects any inbound STAKING_REWARD whose
 *                           `external_epoch_ref` is `<=` the staker's
 *                           last processed value.
 * @param rewardEpochIndex   WIRE epoch index — informational; the
 *                           depot logs it on the credit row.
 */
export async function emitYieldBatch(
  contract: MockYieldEmitterContract,
  entries: YieldEntry[],
  externalEpochRef: bigint,
  rewardEpochIndex: number
): Promise<ethers.TransactionReceipt> {
  Assert.ok(entries.length > 0, "EthYieldEmitterTool: empty entries")
  Assert.ok(externalEpochRef > 0n, "EthYieldEmitterTool: externalEpochRef must be positive")

  const stakers       = entries.map(e => e.staker)
  const wireAccounts  = entries.map(e => e.wireAccount)
  const rewardAmounts = entries.map(e => e.rewardAmount)
  const shareBpses    = entries.map(e => e.shareBps)

  const nonce = await resolveLatestNonce(contract as unknown as ethers.BaseContract)
  const tx = await contract.emitYield(
    stakers,
    wireAccounts,
    rewardAmounts,
    shareBpses,
    externalEpochRef,
    rewardEpochIndex,
    { nonce }
  )
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthYieldEmitterTool: emitYield tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt
}
