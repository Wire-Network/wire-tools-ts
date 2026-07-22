import * as anchor from "@coral-xyz/anchor"
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token"
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js"
import { SystemContracts } from "@wireio/sdk-core"
import {
  pollUntil,
  resolveLatestNonce,
  type FlowTestContext,
  type SwapUserIdentities,
  type WireUser
} from "@wireio/test-cluster-tool"
import {
  StressPrivateReserveCreateParams,
  StressPrivateReserveMatchRequests
} from "@wireio/test-flow-swap-stress-saturation"
import { ethers } from "ethers"

import {
  EthLocalReserveStatus,
  Reserves,
  SolanaSeeds,
  Timing
} from "./realFlowConstants.js"
import {
  accountNamespace,
  reserveRow,
  reserveStatusIs,
  slugNameToLeBuffer
} from "./realFlowUtils.js"

/** Create the Ethereum private reserve used by the real stress flow. */
export async function createEthereumPrivateReserve(
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

/** Create the Solana private reserve used by the real stress flow. */
export async function createSolanaPrivateReserve(
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

/** Wait until both depot private-reserve rows are pending. */
export async function waitForDepotPrivateRowsPending(
  context: FlowTestContext
): Promise<void> {
  await pollUntil(
    "stress private depot rows status=PENDING",
    async () => {
      const ethereum = await reserveRow(
          context,
          Reserves.Ethereum.ChainCode,
          Reserves.Ethereum.TokenCode
        ),
        solana = await reserveRow(
          context,
          Reserves.Solana.ChainCode,
          Reserves.Solana.TokenCode
        )
      return (
        reserveStatusIs(
          ethereum,
          SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING
        ) &&
        reserveStatusIs(
          solana,
          SystemContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING
        )
      )
    },
    Timing.RelayDeadlineMs,
    Timing.LongPollIntervalMs
  )
}

/** Match one pending depot private reserve. */
export async function pushMatchReserve(
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

/** Report whether the Ethereum private reserve is active. */
export async function ethereumPrivateReserveActive(
  reserveManager: ethers.Contract
): Promise<boolean> {
  const record = await reserveManager.getReserve(
    BigInt(Reserves.Ethereum.TokenCode),
    BigInt(Reserves.PrivateReserveCode)
  )
  return Number(record.status) === EthLocalReserveStatus.ACTIVE
}

/** Report whether the Solana private reserve is active. */
export async function solanaPrivateReserveActive(
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
