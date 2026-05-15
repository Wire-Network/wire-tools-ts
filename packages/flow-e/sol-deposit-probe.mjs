#!/usr/bin/env node
// Standalone SOL outpost::deposit probe.
// Generates a fresh keypair, airdrops SOL, calls deposit(BATCH, SOL, 2_000_000) on the running cluster.
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js"

import fs from "node:fs"

const PROGRAM_ID = new PublicKey("2FcAgnSdn29VXZ3eF2jS4U4KzGaYm5M9Wha1CtArm9EU")
const RPC = "http://127.0.0.1:8899"
const IDL_PATH = "/data/shared/code/wire/wire-solana/target/idl/opp_outpost.json"
const AMOUNT_LAMPORTS = 2_000_000n

const conn = new Connection(RPC, "confirmed")

function pda(seed) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0]
}

const depositor = Keypair.generate()
console.log(`depositor=${depositor.publicKey.toBase58()}`)

console.log(`airdropping 1 SOL...`)
const airdropSig = await conn.requestAirdrop(depositor.publicKey, LAMPORTS_PER_SOL)
const deadline1 = Date.now() + 30_000
while (Date.now() < deadline1) {
  const s = await conn.getSignatureStatus(airdropSig)
  const c = s?.value?.confirmationStatus
  if (c === "confirmed" || c === "finalized") break
  await new Promise(r => setTimeout(r, 500))
}
console.log(`airdrop confirmed: balance=${await conn.getBalance(depositor.publicKey)}`)

const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"))
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(depositor), { commitment: "confirmed" })
const program = new anchor.Program(idl, provider)

const configPda             = pda("outpost_config")
const operatorRegistryPda   = pda("operator_registry")
const outboundMessageBuffer = pda("outbound_message_buffer")
const vaultPda              = pda("outpost_vault")

console.log(`config=${configPda.toBase58()}`)
console.log(`operator_registry=${operatorRegistryPda.toBase58()}`)
console.log(`outbound_message_buffer=${outboundMessageBuffer.toBase58()}`)
console.log(`vault=${vaultPda.toBase58()}`)

console.log("building deposit IX with { operatorTypeBatch: {} } + { tokenKindSol: {} } + amount")
try {
  const tx = await program.methods
    .deposit({ operatorTypeBatch: {} }, { tokenKindSol: {} }, new anchor.default.BN(AMOUNT_LAMPORTS.toString()))
    .accounts({
      depositor:              depositor.publicKey,
      config:                 configPda,
      operatorRegistry:       operatorRegistryPda,
      outboundMessageBuffer:  outboundMessageBuffer,
      vault:                  vaultPda,
      systemProgram:          SystemProgram.programId
    })
    .signers([depositor])
    .transaction()

  const sig = await conn.sendTransaction(tx, [depositor], { skipPreflight: false })
  console.log(`sent: ${sig}`)
  const deadline2 = Date.now() + 30_000
  while (Date.now() < deadline2) {
    const s = await conn.getSignatureStatus(sig)
    const c = s?.value?.confirmationStatus
    if (c === "confirmed" || c === "finalized") {
      console.log(`CONFIRMED: status=${JSON.stringify(s.value)}`)
      break
    }
    if (s?.value?.err) {
      console.log(`FAILED: err=${JSON.stringify(s.value.err)}`)
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
  // Pull tx details
  const txDetails = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
  if (txDetails?.meta?.logMessages) {
    console.log("---tx logs---")
    txDetails.meta.logMessages.forEach(l => console.log(l))
  }
  if (txDetails?.meta?.err) {
    console.log(`tx meta err: ${JSON.stringify(txDetails.meta.err)}`)
  }
} catch (e) {
  console.log(`THROWN: ${e.message}`)
  if (e.logs) {
    console.log("---error logs---")
    e.logs.forEach(l => console.log(l))
  }
}
