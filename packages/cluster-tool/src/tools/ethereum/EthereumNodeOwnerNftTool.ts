/**
 * NodeOwnerNFTTool — helpers for the flow-node-owner-nft test.
 *
 * Wraps three surfaces:
 *
 *   - MockWireNodes.sol (wire-ethereum `contracts/test/outpost/`):
 *     ERC-1155 stand-in for the production WireNodes NFT
 *     (0xdbe09a801e19c6568c515b0e24cc2337442d4f41) with a fixed
 *     `1 ether` mint price so anvil can drive it without a Chainlink
 *     fixture.
 *
 *   - BAR.sol `commitNode` (wire-ethereum `contracts/outpost/`): the
 *     PRODUCTION claim entry point. Draws claims from BAR's canonical
 *     WireNodes contract and escrows the committed unit in BAR (one unit
 *     backs at most one registration; the committer must approve BAR as
 *     an ERC-1155 operator first). Emits the full NODE_OWNER_REG
 *     `NodeOwnerRegistration` attestation via OPP, which the depot
 *     (`sysio.msgch::dispatch_node_owner_reg`) consumes end-to-end.
 *
 *   - sysio.roa create-in-flow node-owner registration (wire-sysio):
 *     the two actions the depot inline-sends when an inbound
 *     NodeOwnerRegistration decodes — sysio.roa::newnameduser (create
 *     the account from the claim's Wire key) then sysio.roa::nodeownreg
 *     (register + inline-record the depositor's ETH link in
 *     sysio.authex). The flow's soft-fail / hard-abort probes drive
 *     these directly (as the depot inline-sends them); the commit path
 *     above exercises the same pair through the real OPP hop.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { SysioContracts } from "@wireio/sdk-core"
import { NodeOwnerTier, type WireKey } from "@wireio/opp-typescript-models"

import type { WireClient } from "../../clients/wire/WireClient.js"
import { loadOutpostContract, resolveLatestNonce, type EthereumValueOverrides } from "../../utils/ethereumUtils.js"
import type { ClioError } from "../../clients/wire/clio/ClioRunner.js"

// Tier IDs accepted by sysio.roa::nodeownreg (matches MockWireNodes NodeInfo). The canonical enum
// lives in the OPP protobuf models (sysio.opp.types.NodeOwnerTier: T1=1, T2=2, T3=3); re-exported
// here so flows keep importing it from @wireio/cluster-tool.
export { NodeOwnerTier }

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
export interface MockWireNodesContract extends ethers.BaseContract {
  mint: (
    id: bigint | number,
    amount: bigint | number,
    overrides?: EthereumValueOverrides
  ) => Promise<ethers.ContractTransactionResponse>
  viewTotalSupply: (id: bigint | number) => Promise<bigint>
  viewMaxSupply: (id: bigint | number) => Promise<bigint>
  balanceOf: (account: string, id: bigint | number) => Promise<bigint>
  setApprovalForAll: (
    operator: string,
    approved: boolean,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  isApprovedForAll: (account: string, operator: string) => Promise<boolean>
  getAddress: () => Promise<string>
}

/**
 * Load the deployed `MockWireNodes` fixture from the run's wire-ethereum
 * deploy artifacts (`outpost-addrs.json` + the hardhat artifact), bound to
 * `signer`.
 */
export function loadMockWireNodes(
  ethereumPath: string,
  outpostAddrs: Record<string, string>,
  signer: ethers.Signer
): MockWireNodesContract {
  return loadOutpostContract<MockWireNodesContract>(
    ethereumPath,
    outpostAddrs,
    "MockWireNodes",
    ["test", "outpost"],
    signer
  )
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
  const value = ethers.parseEther(String(amount)),
    nonce = await resolveLatestNonce(contract)
  const tx = await contract.mint(tier, amount, { value, nonce })
  const receipt = await tx.wait(1)
  Assert.ok(receipt, "mintNodeNFT: receipt is null")
  return receipt
}

/**
 * One-time ERC-1155 operator approval so BAR can pull the committed unit
 * into escrow. `BAR.commitNode` consumes the claimed unit (escrows it in
 * BAR before the attestation is queued), so the committer must have
 * approved BAR on WireNodes first — without it the commit reverts with the
 * token's `ERC1155MissingApprovalForAll`.
 *
 * @param contract - The committer-bound WireNodes surface.
 * @param barAddress - The BAR contract address (the escrow operator).
 * @returns The mined receipt.
 */
export async function approveNodeEscrow(
  contract: MockWireNodesContract,
  barAddress: string
): Promise<ethers.ContractTransactionReceipt> {
  const nonce = await resolveLatestNonce(contract)
  const tx = await contract.setApprovalForAll(barAddress, true, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(receipt, "approveNodeEscrow: receipt is null")
  return receipt
}

/** Minimal `ethers` surface of `BAR.sol` for the node-owner commit path. */
export interface BarContract extends ethers.BaseContract {
  commitNode: (
    tokenId: bigint | number,
    wireAccountName: string,
    wirePublicKey: WireKey,
    depositorPublicKey: string,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  getAddress: () => Promise<string>
}

/**
 * Load the deployed `BAR` contract from the run's wire-ethereum deploy
 * artifacts (`outpost-addrs.json` + the hardhat artifact), bound to `signer`.
 */
export function loadBar(
  ethereumPath: string,
  outpostAddrs: Record<string, string>,
  signer: ethers.Signer
): BarContract {
  return loadOutpostContract<BarContract>(ethereumPath, outpostAddrs, "BAR", ["outpost"], signer)
}

/**
 * Commit a node NFT via `BAR.commitNode` — the production claim entry point.
 * Claims are drawn from the canonical WireNodes contract configured in BAR
 * (`setWireNodesContract`, wired by deployLocal on the local cluster), and
 * the commit ESCROWS the claimed unit in BAR — the signer must hold ≥ 1
 * unit of `tier` and have approved BAR first (see {@link approveNodeEscrow}).
 * The contract validates every payload class the depot would silently drop
 * (tier from the tokenId, name charset/length, Wire key usability, the
 * depositor key deriving the caller) and queues the full
 * `NodeOwnerRegistration` NODE_OWNER_REG attestation for the next outbound
 * OPP envelope.
 *
 * @param contract - The signer-bound BAR surface; the signer must hold ≥ 1 of `tier` and match `depositorPublicKey`.
 * @param tier - The claimed tier — WireNodes token ids ARE the tiers, so this is also the tokenId committed.
 * @param wireAccountName - The Wire account to register (created in-flow when absent).
 * @param wirePublicKey - The account's owner/active authority as the proto `WireKey`.
 * @param depositorPublicKey - The caller's 65-byte SEC1 uncompressed public key (`0x04 || X || Y`).
 * @returns The mined receipt.
 */
export async function commitNode(
  contract: BarContract,
  tier: NodeOwnerTier,
  wireAccountName: string,
  wirePublicKey: WireKey,
  depositorPublicKey: string
): Promise<ethers.ContractTransactionReceipt> {
  const nonce = await resolveLatestNonce(contract)
  const tx = await contract.commitNode(tier, wireAccountName, wirePublicKey, depositorPublicKey, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(receipt, "commitNode: receipt is null")
  return receipt
}

/**
 * Create the claim account in-flow via `sysio.roa::newnameduser` (the create step the depot
 * inline-sends first). `wirePubKey` becomes the account's owner/active authority. Idempotent and
 * non-throwing on a tier-invalid name, matching the contract.
 *
 * @param account     The vanity account name to create (tier-1 = 2-6 chars; tier 2/3 = 1-12).
 * @param wirePubKey  The holder's Wire owner/active public key (e.g. PUB_K1_*).
 * @param tier        1 (T1), 2 (T2), or 3 (T3).
 */
export async function pushNewNamedUser(
  wire: WireClient,
  account: string,
  wirePubKey: string,
  tier: NodeOwnerTier
): Promise<void> {
  await wire.invoke<SysioContracts.SysioRoaNewnameduserAction>(
    "sysio.roa",
    "newnameduser",
    { account, pubkey: wirePubKey, tier },
    [{ actor: "sysio.roa", permission: "active" }]
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
 * @param tier          1 (T1), 2 (T2), or 3 (T3).
 * @param ethPubKey     Depositor's `PUB_EM_*` secp256k1 key (recorded as the sysio.authex link).
 * @param wirePubKey    The account's owner/active key; an existing account must be controlled by it.
 */
export async function pushNodeOwnerReg(
  wire: WireClient,
  ownerAccount: string,
  tier: NodeOwnerTier,
  ethPubKey: string,
  wirePubKey: string
): Promise<void> {
  try {
    await wire.invoke<SysioContracts.SysioRoaNodeownregAction>(
      "sysio.roa",
      "nodeownreg",
      {
        owner: ownerAccount,
        tier,
        eth_pub_key: ethPubKey,
        wire_pub_key: wirePubKey
      },
      [{ actor: "sysio.roa", permission: "active" }]
    )
  } catch (err) {
    // child_process.exec wraps clio failures with `Error("Command failed: <cmd>")` and stuffs clio's
    // `-j` JSON output on `err.stdout`. Surface the underlying sysio_assert_message so callers can
    // match the actual hard-abort reason (invalid tier / non-EM key) with `rejects.toThrow(/.../)`.
    const stdout = (err as ClioError)?.stdout ?? ""
    const m = /assertion failure with message: ([^"\n]+)/.exec(stdout)
    if (m) {
      throw new Error(`nodeownreg failed: ${m[1]}`, { cause: err })
    }
    throw err
  }
}

/** Read the nodeownerreg audit row for `owner` (scope = network_gen = 0), or absent. */
export async function readNodeOwnerReg(
  wire: WireClient,
  owner: string
): Promise<SysioContracts.SysioRoaNodeownerregType> {
  const { rows } = await wire
    .getSysioContract(SysioContracts.SysioContractName.roa)
    .tables.nodeownerreg.query({ scope: "0" })
  return rows.find(row => row.owner === owner)
}

/** Read the nodeowners registration row for `owner` (scope = network_gen = 0), or absent. */
export async function readNodeOwner(wire: WireClient, owner: string): Promise<SysioContracts.SysioRoaNodeownersType> {
  const { rows } = await wire
    .getSysioContract(SysioContracts.SysioContractName.roa)
    .tables.nodeowners.query({ scope: "0" })
  return rows.find(row => row.owner === owner)
}
