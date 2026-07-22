import * as Path from "node:path"

import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { ChainKind } from "@wireio/opp-typescript-models"
import { Bytes, KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  FlowTestContext,
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  ensureSwapUserIdentities,
  mintMockSplToUser,
  provisionWireUser
} from "@wireio/test-cluster-tool"
import {
  setupStressPrivateReserves
} from "@wireio/test-flow-swap-stress-saturation"
import { ethers } from "ethers"

import {
  Accounts,
  RealRamp,
  SplFunding,
  Timing,
  underwriterCollateral,
  underwriterRequirements
} from "./realFlowConstants.js"
import { readAnchorIdl, readKeypair, readSplMints } from "./realFlowReaders.js"
import {
  createEthereumPrivateReserve,
  createSolanaPrivateReserve,
  ethereumPrivateReserveActive,
  pushMatchReserve,
  solanaPrivateReserveActive,
  waitForDepotPrivateRowsPending
} from "./realFlowReserveSetup.js"
import { provisionStressWireAccounts } from "./realStressWireAccounts.js"
import {
  findSplMint,
  readActiveSnapshot
} from "./realFlowUtils.js"
import type { RealStressFlow } from "./realFlowTypes.js"
import type { SwapUserIdentities, WireUser } from "@wireio/test-cluster-tool"

type SolanaContext = {
  readonly connection: Connection
  readonly oppProgram: anchor.Program<anchor.Idl>
  readonly usdcSolMint: PublicKey
  readonly deployer: Keypair
}

/** Error raised when the fresh stress flow inherits unsupported attach mode. */
export class RealStressAttachModeError extends Error {
  readonly name = "RealStressAttachModeError"

  /** @param configPath Inherited attach-mode config rejected by this fresh flow. */
  constructor(readonly configPath: string) {
    super(`real stress flow requires fresh mode; WIRE_CLUSTER_CONFIG=${configPath}`)
  }
}

/** Bootstrap the real local-cluster state required by the stress ramp. */
export async function createRealStressFlow(
  clusterPath: string
): Promise<RealStressFlow> {
  const inheritedConfig = process.env.WIRE_CLUSTER_CONFIG
  if (inheritedConfig !== undefined && inheritedConfig !== "")
    throw new RealStressAttachModeError(inheritedConfig)
  const context = await FlowTestContext.create({
      clusterPath,
      epochDurationSec: Timing.EpochDurationSec,
      reqUwCollat: underwriterRequirements(),
      underwriterCollateral: [underwriterCollateral()]
    }),
    users = await ensureSwapUserIdentities(context),
    owner = await provisionStressOwner(context, users),
    reserveManager = bindReserveManager(context, users),
    solana = await loadSolanaContext(context, users)

  await mintMockSplToUser(
    solana.connection,
    solana.deployer,
    solana.usdcSolMint,
    users.solanaKeypair.publicKey,
    SplFunding.CreatorMintAmount
  )
  await setupStressPrivateReserves({
    createEthereumPrivateReserve: () =>
      createEthereumPrivateReserve(reserveManager, users),
    createSolanaPrivateReserve: () =>
      createSolanaPrivateReserve(
        solana.oppProgram,
        solana.connection,
        users,
        solana.usdcSolMint
      ),
    waitForDepotPrivateRowsPending: () =>
      waitForDepotPrivateRowsPending(context),
    pushMatchReserve: request =>
      pushMatchReserve(context, owner, request.side, request.wireAmount),
    ethereumPrivateReserveActive: () =>
      ethereumPrivateReserveActive(reserveManager),
    solanaPrivateReserveActive: () =>
      solanaPrivateReserveActive(solana.oppProgram),
    readActiveSnapshot: () => readActiveSnapshot(context)
  })
  await provisionStressWireAccounts(context)

  return {
    context,
    users,
    owner,
    reserveManager,
    oppProgram: solana.oppProgram,
    solanaConnection: solana.connection,
    usdcSolMint: solana.usdcSolMint,
    solDeployer: solana.deployer
  }
}

async function provisionStressOwner(
  context: FlowTestContext,
  users: SwapUserIdentities
): Promise<WireUser> {
  const owner = await provisionWireUser(
    context.wireClient.clio,
    Accounts.Owner,
    { fundWireAmount: Accounts.OwnerFunding }
  )
  await createAuthExLink(context.wireClient.clio, {
    chainKind: ChainKind.EVM,
    account: owner.account,
    privateKey: emPrivateKeyFromEthWallet(users.ethereumWallet),
    ethWallet: users.ethereumWallet
  })
  await createAuthExLink(context.wireClient.clio, {
    chainKind: ChainKind.SVM,
    account: owner.account,
    privateKey: PrivateKey.regenerate(
      KeyType.ED,
      Bytes.fromString(
        Buffer.from(users.solanaKeypair.secretKey).toString("hex"),
        "hex"
      )
    )
  })
  return owner
}

function bindReserveManager(
  context: FlowTestContext,
  users: SwapUserIdentities
): ethers.Contract {
  const addresses = context.loadETHAddresses()
  return narrowReserveManagerContract(
    context
      .loadETHContract("ReserveManager", addresses.ReserveManager)
      .connect(users.ethereumWallet)
  )
}

function narrowReserveManagerContract(
  contract: ethers.BaseContract
): ethers.Contract {
  return contract as ethers.Contract
}

async function loadSolanaContext(
  context: FlowTestContext,
  users: SwapUserIdentities
): Promise<SolanaContext> {
  const solanaPath = context.solanaPath
  if (solanaPath === undefined)
    throw new Error("flow-swap-stress-saturation requires WIRE_SOLANA_PATH")
  const idlPath = Path.join(solanaPath, "target", "idl", "opp_outpost.json"),
    idl = readAnchorIdl(idlPath),
    connection = new Connection(
      `http://127.0.0.1:${context.ports.solanaRpc}`,
      "confirmed"
    ),
    provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(users.solanaKeypair),
      { commitment: "confirmed" }
    ),
    mints = readSplMints(
      Path.join(context.clusterPath, "data", "sol-mock-mints.json")
    ),
    usdcSolMint = findSplMint(mints),
    deployer = readKeypair(
      Path.join(context.clusterPath, "data", "sol-deployer-keypair.json")
    )
  return {
    connection,
    oppProgram: new anchor.Program(idl, provider),
    usdcSolMint,
    deployer
  }
}
