import * as Path from "node:path"

import * as anchor from "@coral-xyz/anchor"
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token"
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { ChainKind } from "@wireio/opp-typescript-models"
import { Bytes, KeyType, PrivateKey, SystemContracts } from "@wireio/sdk-core"
import {
  FlowTestContext,
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  ensureSwapUserIdentities,
  mintMockSplToUser,
  pollUntil,
  provisionWireUser,
  resolveLatestNonce
} from "@wireio/test-cluster-tool"
import {
  setupStressPrivateReserves,
  StressPrivateReserveCreateParams,
  StressPrivateReserveMatchRequests
} from "@wireio/test-flow-swap-stress-saturation"
import { ethers } from "ethers"

import {
  Accounts,
  EthLocalReserveStatus,
  RealRamp,
  Reserves,
  SolanaSeeds,
  SplFunding,
  Timing,
  underwriterCollateral,
  underwriterRequirements
} from "./realFlowConstants.js"
import { readAnchorIdl, readKeypair, readSplMints } from "./realFlowReaders.js"
import { provisionStressWireAccounts } from "./realStressWireAccounts.js"
import {
  accountNamespace,
  findSplMint,
  readActiveSnapshot,
  reserveRow,
  reserveStatusIs,
  slugNameToLeBuffer
} from "./realFlowUtils.js"
import type { RealStressFlow } from "./realFlowTypes.js"
import type { SwapUserIdentities, WireUser } from "@wireio/test-cluster-tool"

type SolanaContext = {
  readonly connection: Connection
  readonly oppProgram: anchor.Program<anchor.Idl>
  readonly usdcSolMint: PublicKey
  readonly deployer: Keypair
}

/** Bootstrap the real local-cluster state required by the stress ramp. */
export async function createRealStressFlow(): Promise<RealStressFlow> {
  const context = await FlowTestContext.create({
      clusterPath:
        process.env.WIRE_CLUSTER_PATH ??
        Path.join("/tmp", `wire-swap-stress-${process.pid}`),
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

async function createEthereumPrivateReserve(
  reserveManager: ethers.Contract,
  users: SwapUserIdentities
): Promise<void> {
  const nonce = await resolveLatestNonce(reserveManager),
    tx = await reserveManager.create_reserve(
      BigInt(Reserves.Ethereum.TokenCode),
      BigInt(Reserves.PrivateReserveCode),
      StressPrivateReserveCreateParams.EthereumEscrowWei,
      StressPrivateReserveCreateParams.EthereumRequestedWire,
      StressPrivateReserveCreateParams.ConnectorWeightBps,
      "ETHEREUM-ETH/WIRE stress private reserve",
      "flow-swap-stress-saturation ETH-side private reserve",
      true,
      users.ethereumWallet.signingKey.compressedPublicKey,
      { value: StressPrivateReserveCreateParams.EthereumEscrowWei, nonce }
    ),
    receipt = await tx.wait(1)
  if (receipt?.status !== 1)
    throw new Error("create_reserve(ETH/PRIVATE) reverted")
}

async function createSolanaPrivateReserve(
  oppProgram: anchor.Program<anchor.Idl>,
  connection: Connection,
  users: SwapUserIdentities,
  usdcSolMint: PublicKey
): Promise<void> {
  const programId = oppProgram.programId,
    [configPda] = PublicKey.findProgramAddressSync(
      [SolanaSeeds.OutpostConfig],
      programId
    ),
    [bufferPda] = PublicKey.findProgramAddressSync(
      [SolanaSeeds.OutboundMessageBuffer],
      programId
    ),
    tokenCode = slugNameToLeBuffer(Reserves.Solana.TokenCode),
    reserveCode = slugNameToLeBuffer(Reserves.PrivateReserveCode),
    [reservePda] = PublicKey.findProgramAddressSync(
      [SolanaSeeds.Reserve, tokenCode, reserveCode],
      programId
    ),
    [reserveVaultPda] = PublicKey.findProgramAddressSync(
      [SolanaSeeds.ReserveVault, tokenCode, reserveCode],
      programId
    ),
    userAta = getAssociatedTokenAddressSync(
      usdcSolMint,
      users.solanaKeypair.publicKey
    ),
    tx = await oppProgram.methods
      .createReserve(
        new anchor.BN(Reserves.Solana.TokenCode),
        new anchor.BN(Reserves.PrivateReserveCode),
        new anchor.BN(
          StressPrivateReserveCreateParams.SolanaEscrowChainUnits.toString()
        ),
        new anchor.BN(
          StressPrivateReserveCreateParams.SolanaRequestedWire.toString()
        ),
        StressPrivateReserveCreateParams.ConnectorWeightBps,
        "SOLANA-USDCSOL/WIRE stress private reserve",
        "flow-swap-stress-saturation SOL-side private reserve",
        true
      )
      .accounts({
        creator: users.solanaKeypair.publicKey,
        config: configPda,
        reserve: reservePda,
        reserveVault: reserveVaultPda,
        mint: usdcSolMint,
        creatorAta: userAta,
        outboundMessageBuffer: bufferPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY
      })
      .signers([users.solanaKeypair])
      .transaction()
  await connection.sendTransaction(tx, [users.solanaKeypair], {
    skipPreflight: false
  })
}

async function waitForDepotPrivateRowsPending(
  context: FlowTestContext
): Promise<void> {
  await pollUntil(
    "stress private depot rows status=PENDING",
    async () => {
      const eth = await reserveRow(
          context,
          Reserves.Ethereum.ChainCode,
          Reserves.Ethereum.TokenCode
        ),
        sol = await reserveRow(
          context,
          Reserves.Solana.ChainCode,
          Reserves.Solana.TokenCode
        )
      return (
        reserveStatusIs(
          eth,
          SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING
        ) &&
        reserveStatusIs(
          sol,
          SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING
        )
      )
    },
    Timing.RelayDeadlineMs,
    Timing.LongPollIntervalMs
  )
}

async function pushMatchReserve(
  context: FlowTestContext,
  owner: WireUser,
  side: "ethereum" | "solana",
  wireAmount: bigint
): Promise<void> {
  const chainCode =
      side === StressPrivateReserveMatchRequests.Ethereum.side
        ? Reserves.Ethereum.ChainCode
        : Reserves.Solana.ChainCode,
    tokenCode =
      side === StressPrivateReserveMatchRequests.Ethereum.side
        ? Reserves.Ethereum.TokenCode
        : Reserves.Solana.TokenCode
  await context.wireClient.clio.pushActionAndWait<SystemContracts.SysioReservMatchreserveAction>(
    "sysio.reserv",
    "matchreserve",
    {
      chain_code: { value: chainCode },
      token_code: { value: tokenCode },
      reserve_code: { value: Reserves.PrivateReserveCode },
      matcher: owner.account,
      wire_amount: Number(wireAmount)
    },
    `${owner.account}@active`
  )
}

async function ethereumPrivateReserveActive(
  reserveManager: ethers.Contract
): Promise<boolean> {
  const record = await reserveManager.getReserve(
    BigInt(Reserves.Ethereum.TokenCode),
    BigInt(Reserves.PrivateReserveCode)
  )
  return Number(record.status) === EthLocalReserveStatus.ACTIVE
}

async function solanaPrivateReserveActive(
  oppProgram: anchor.Program<anchor.Idl>
): Promise<boolean> {
  const [reservePda] = PublicKey.findProgramAddressSync(
      [
        SolanaSeeds.Reserve,
        slugNameToLeBuffer(Reserves.Solana.TokenCode),
        slugNameToLeBuffer(Reserves.PrivateReserveCode)
      ],
      oppProgram.programId
    ),
    reserveAccount = accountNamespace(oppProgram.account, "reserve"),
    account = await reserveAccount.fetch(reservePda)
  return (
    typeof account.status === "object" &&
    account.status !== null &&
    "active" in account.status
  )
}
