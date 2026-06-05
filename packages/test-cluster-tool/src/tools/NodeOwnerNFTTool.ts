/**
 * NodeOwnerNFTTool — helpers for the flow-node-owner-nft test.
 *
 * Wraps two surfaces:
 *
 *   - MockWireNodes.sol (wire-ethereum `contracts/test/outpost/`):
 *     ERC-1155 stand-in for the production WireNodes NFT
 *     (0xdbe09a801e19c6568c515b0e24cc2337442d4f41) with a fixed
 *     `1 ether` mint price so anvil can drive it without a Chainlink
 *     fixture.
 *
 *   - sysio.roa create-in-flow node-owner registration (wire-sysio):
 *     the production depot (sysio.msgch) decodes an inbound OPP
 *     NodeOwnerRegistration and inline-sends sysio.roa::newnameduser
 *     (create the account from the claim's Wire key) then
 *     sysio.roa::nodeownreg (register + inline-record the depositor's
 *     ETH link in sysio.authex). This flow drives those two roa actions
 *     directly (as the depot inline-sends them) — matching the patch's
 *     own integration test (tests/nodeownreg_test.py).
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { SystemContracts } from "@wireio/sdk-core"

import type { Clio } from "../clients/Clio.js"

/** Tier IDs accepted by sysio.roa::nodeownreg (matches MockWireNodes NodeInfo). */
export enum NodeOwnerTier {
  Validator = 1,
  Compute = 2,
  Operator = 3
}

/** nodeownerreg.reg_status values (mirror sysio.roa.hpp). */
export enum NodeOwnerRegStatus {
  Confirmed = 0,
  Rejected = 1
}

/** nodeownerreg.reject_reason values (mirror sysio.roa.hpp); meaningful only when REJECTED. */
export enum NodeOwnerRejectReason {
  None = 0,
  NameInvalid = 1,
  OwnerNotAccount = 2,
  AccountKeyMismatch = 3,
  Duplicate = 4,
  LinkKeyMismatch = 5
}

/** Minimal `ethers` surface of `MockWireNodes.sol`. */
export interface MockWireNodesContract {
  mint: (
    id: bigint | number,
    amount: bigint | number,
    overrides?: ethers.Overrides & { value?: bigint }
  ) => Promise<ethers.ContractTransactionResponse>
  viewTotalSupply: (id: bigint | number) => Promise<bigint>
  viewMaxSupply: (id: bigint | number) => Promise<bigint>
  balanceOf: (account: string, id: bigint | number) => Promise<bigint>
  getAddress: () => Promise<string>
}

/**
 * Load the hardhat-emitted `MockWireNodes.json` artifact from
 * wire-ethereum and look up its deployed address from the matching
 * `outpost-addrs.json`. Mirrors `loadMockYieldEmitter` exactly so
 * callers can read both off the same `outpostAddrs` map.
 */
export function loadMockWireNodes(
  ethereumPath: string,
  outpostAddrs: Record<string, string>,
  signer: ethers.Signer
): MockWireNodesContract {
  const addr = outpostAddrs.MockWireNodes
  Assert.ok(
    addr && /^0x[0-9a-fA-F]{40}$/.test(addr),
    `NodeOwnerNFTTool: MockWireNodes not in outpost-addrs.json (got ${addr}). ` +
      `Did wire-ethereum's deployLocal.ts run with the contract enabled?`
  )

  const artifactPath = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    "test",
    "outpost",
    "MockWireNodes.sol",
    "MockWireNodes.json"
  )
  Assert.ok(
    Fs.existsSync(artifactPath),
    `NodeOwnerNFTTool: artifact not found at ${artifactPath}. ` +
      `Run \`npx hardhat compile\` in wire-ethereum first.`
  )
  const artifact = JSON.parse(Fs.readFileSync(artifactPath, "utf-8"))
  return new ethers.Contract(addr, artifact.abi, signer) as unknown as MockWireNodesContract
}

/**
 * Mint `amount` NFTs of `tier` from MockWireNodes. The contract charges
 * `1 ether * amount`; this helper computes and supplies the value.
 *
 * Returns the receipt so callers can read TransferSingle events if they
 * want the production-mirroring "the mint was observed" sanity.
 */
export async function mintNodeNFT(
  contract: MockWireNodesContract,
  tier: NodeOwnerTier,
  amount: number = 1
): Promise<ethers.ContractTransactionReceipt> {
  const value = ethers.parseEther(String(amount))
  const tx = await contract.mint(tier, amount, { value })
  const receipt = await tx.wait()
  Assert.ok(receipt, "mintNodeNFT: receipt is null")
  return receipt
}

/**
 * Create the claim account in-flow via `sysio.roa::newnameduser` (the create step the depot
 * inline-sends first). `wirePubKey` becomes the account's owner/active authority. Idempotent and
 * non-throwing on a tier-invalid name, matching the contract.
 *
 * @param account     The vanity account name to create (tier-1 = 2-6 chars; tier 2/3 = 1-12).
 * @param wirePubKey  The holder's Wire owner/active public key (e.g. PUB_K1_*).
 * @param tier        1 (Validator), 2 (Compute), or 3 (Operator).
 */
export async function pushNewNamedUser(
  clio: Clio,
  account: string,
  wirePubKey: string,
  tier: NodeOwnerTier
): Promise<void> {
  await clio.pushActionAndWait<SystemContracts.SysioRoaNewnameduserAction>(
    "sysio.roa",
    "newnameduser",
    { account, pubkey: wirePubKey, tier },
    "sysio.roa@active"
  )
}

/**
 * Drive `sysio.roa::nodeownreg` directly, as the depot inline-sends it. The account is expected to
 * already exist (created by pushNewNamedUser). Under create-in-flow this RECORDS the depositor's ETH
 * key (it is not verified against a pre-existing link), so claim-payload problems soft-fail into a
 * `nodeownerreg` audit row (read with `readNodeOwnerReg`) rather than throwing. Only depot/system
 * invariants -- tier out of [1,3] and a non-EM eth key -- hard-abort, which this surfaces as a throw.
 *
 * @param ownerAccount  The Wire account to register.
 * @param tier          1 (Validator), 2 (Compute), or 3 (Operator).
 * @param ethPubKey     Depositor's `PUB_EM_*` secp256k1 key (recorded as the sysio.authex link).
 * @param wirePubKey    The account's owner/active key; an existing account must be controlled by it.
 */
export async function pushNodeOwnerReg(
  clio: Clio,
  ownerAccount: string,
  tier: NodeOwnerTier,
  ethPubKey: string,
  wirePubKey: string
): Promise<void> {
  try {
    await clio.pushActionAndWait<SystemContracts.SysioRoaNodeownregAction>(
      "sysio.roa",
      "nodeownreg",
      {
        owner: ownerAccount,
        tier,
        eth_pub_key: ethPubKey,
        wire_pub_key: wirePubKey
      },
      "sysio.roa@active"
    )
  } catch (err) {
    // child_process.exec wraps clio failures with `Error("Command failed: <cmd>")` and stuffs clio's
    // `-j` JSON output on `err.stdout`. Surface the underlying sysio_assert_message so callers can
    // match the actual hard-abort reason (invalid tier / non-EM key) with `rejects.toThrow(/.../)`.
    const stdout = (err as { stdout?: string })?.stdout ?? ""
    const m = /assertion failure with message: ([^"\n]+)/.exec(stdout)
    if (m) {
      throw new Error(`nodeownreg failed: ${m[1]}`, { cause: err })
    }
    throw err
  }
}

/** Find a row by `owner` in a sysio.roa kv::table (rows wrap the struct in a `value` object). */
function findRoaRow<T extends { owner: string }>(tableJson: string, owner: string): T | undefined {
  const parsed = JSON.parse(tableJson) as { rows?: Array<{ value?: T } | T> }
  for (const r of parsed.rows ?? []) {
    const v = (r as { value?: T }).value ?? (r as T)
    if (v && v.owner === owner) return v
  }
  return undefined
}

/** Read the nodeownerreg audit row for `owner` (scope = network_gen = 0), or undefined. */
export async function readNodeOwnerReg(
  clio: Clio,
  owner: string
): Promise<SystemContracts.SysioRoaNodeownerregType | undefined> {
  const json = await clio.getTable("sysio.roa", "0", "nodeownerreg")
  return findRoaRow<SystemContracts.SysioRoaNodeownerregType>(json, owner)
}

/** Read the nodeowners registration row for `owner` (scope = network_gen = 0), or undefined. */
export async function readNodeOwner(
  clio: Clio,
  owner: string
): Promise<SystemContracts.SysioRoaNodeownersType | undefined> {
  const json = await clio.getTable("sysio.roa", "0", "nodeowners")
  return findRoaRow<SystemContracts.SysioRoaNodeownersType>(json, owner)
}
