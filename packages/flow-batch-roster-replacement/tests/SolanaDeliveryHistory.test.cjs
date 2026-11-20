const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { test, after } = require("node:test")
const {
  Keypair,
  PublicKey,
  AddressLookupTableAccount,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram
} = require("@solana/web3.js")
const { ethers } = require("ethers")
const { SolanaOutpostProgramTool } = require("@wireio/cluster-tool")
const {
  SolanaDeliveryHistory: History
} = require("../lib/SolanaDeliveryHistory.js")

const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-delivery-proof-")),
  programId = Keypair.generate().publicKey,
  signer = Keypair.generate().publicKey,
  epochIndex = 7,
  epoch = Buffer.alloc(4),
  names = [
    "operator",
    "config",
    "operator_registry",
    "epoch_deliveries",
    "chunk_buffer"
  ],
  idl = {
    address: programId.toBase58(),
    metadata: { name: "liqsol_core", version: "0.1.0", spec: "0.1.0" },
    instructions: [
      {
        name: "epoch_in",
        discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        accounts: names.map(name => ({ name, signer: name === "operator" })),
        args: [
          { name: "epoch_index", type: "u32" },
          { name: "chunk_index", type: "u16" },
          { name: "total_chunks", type: "u16" },
          { name: "total_bytes", type: "u32" },
          { name: "chunk_data", type: "bytes" }
        ]
      },
      {
        name: "discard_envelope_chunks",
        discriminator: [8, 7, 6, 5, 4, 3, 2, 1],
        accounts: [],
        args: []
      }
    ]
  }
epoch.writeUInt32LE(epochIndex)
Fs.mkdirSync(Path.join(root, "target", "idl"), { recursive: true })
Fs.writeFileSync(
  Path.join(root, "target", "idl", "liqsol_core.json"),
  JSON.stringify(idl)
)
after(() => Fs.rmSync(root, { recursive: true, force: true }))
const program = SolanaOutpostProgramTool.loadReadOnlyProgram({}, root),
  tally = PublicKey.findProgramAddressSync(
    [Buffer.from("epoch_deliveries"), epoch],
    programId
  )[0],
  buffer = PublicKey.findProgramAddressSync(
    [Buffer.from("envelope_chunks"), epoch, signer.toBuffer()],
    programId
  )[0],
  parts = [Buffer.alloc(668, 1), Buffer.from("canonical final chunk")],
  checksum = Array.from(
    ethers.getBytes(ethers.keccak256(Buffer.concat(parts)))
  ),
  accepted = { epochIndex, checksum }

function transaction(index, overrides = {}) {
  const {
      operator = signer,
      signed = true,
      version = "legacy",
      lookup = false,
      ...dataOverrides
    } = overrides,
    data = {
      epochIndex,
      chunkIndex: index,
      totalChunks: parts.length,
      totalBytes: Buffer.concat(parts).length,
      chunkData: parts[index] ?? Buffer.alloc(0),
      ...dataOverrides
    },
    instruction = new TransactionInstruction({
      programId,
      keys: [
        operator,
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        tally,
        buffer
      ].map((pubkey, i) => ({
        pubkey,
        isSigner: i === 0 && signed,
        isWritable: true
      })),
      data: program.coder.instruction.encode("epochIn", data)
    }),
    message = new TransactionMessage({
      payerKey: signed ? operator : Keypair.generate().publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [instruction]
    }),
    table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [tally, buffer]
      }
    }),
    compiled =
      version === "legacy"
        ? message.compileToLegacyMessage()
        : message.compileToV0Message(lookup ? [table] : []),
    event =
      index < parts.length
        ? `opp_outpost: epoch_in chunk op=${operator} epoch=${epochIndex} chunk=${index}/${parts.length} bytes=${data.chunkData.length}`
        : `opp_outpost: epoch_in finalize epoch=${epochIndex} operator=${operator} digest=[prefix only] deliveries=1 consensus_retry=false`
  return {
    slot: index + 1,
    transaction: {
      message: compiled
    },
    meta: {
      err: null,
      loadedAddresses: lookup
        ? {
            writable: compiled.addressTableLookups[0].writableIndexes.map(
              i => table.state.addresses[i]
            ),
            readonly: []
          }
        : undefined,
      logMessages: [
        `Program ${programId} invoke [1]`,
        `Program log: ${event}`,
        `Program ${programId} success`
      ]
    }
  }
}
function proof(transactions, record = accepted, operator = signer) {
  return History.provesDelivery(transactions, program, record, operator)
}
function history(overrides = {}) {
  return [0, 1, 2].map(i => transaction(i, overrides))
}

for (const version of ["legacy", 0])
  test(`complete signed canonical upload survives tally cleanup (${version})`, () => {
    Assert.equal(proof(history({ version })), true)
  })

test("versioned lookup-table accounts retain signer and PDA attribution", () => {
  Assert.equal(proof(history({ version: 0, lookup: true })), true)
  const records = history({ version: 0, lookup: true })
  records[0].meta.loadedAddresses.writable[0] = Keypair.generate().publicKey
  Assert.equal(proof(records), false)
})

test("complete payload is hashed, including bytes beyond the logged digest prefix", () => {
  const wrong = [...checksum]
  wrong[31] ^= 1
  Assert.equal(proof(history(), { ...accepted, checksum: wrong }), false)
  Assert.equal(
    proof(history(), { ...accepted, checksum: checksum.slice(0, 8) }),
    false
  )
})

test("staging, late no-op and failed terminal transactions are absent votes", () => {
  Assert.equal(proof(history().slice(0, 2)), false)
  for (const log of ["late no-op epoch=7 cursor=8", "idempotent chunk retry"]) {
    const records = history()
    records[2].meta.logMessages[1] = `Program log: opp_outpost: epoch_in ${log}`
    Assert.equal(proof(records), false)
  }
  const records = history()
  records[2].meta.err = { InstructionError: [0, "Custom"] }
  Assert.equal(proof(records), false)
})

test("identity, signature, epoch and geometry must all match", () => {
  Assert.equal(proof(history(), accepted, Keypair.generate().publicKey), false)
  Assert.equal(proof(history({ signed: false })), false)
  Assert.equal(
    proof(history(), { ...accepted, epochIndex: epochIndex + 1 }),
    false
  )
  Assert.equal(
    proof([
      transaction(0),
      transaction(1, { totalBytes: 999 }),
      transaction(2)
    ]),
    false
  )
  Assert.equal(proof([transaction(0), transaction(2)]), false)
  Assert.equal(
    proof([transaction(0), transaction(0), transaction(1), transaction(2)]),
    false
  )
  Assert.equal(proof([null, ...history()]), false)
})

test("nested program logs cannot impersonate the direct finalization", () => {
  const records = history(),
    other = Keypair.generate().publicKey
  records[2].meta.logMessages.splice(1, 0, `Program ${other} invoke [2]`)
  records[2].meta.logMessages.splice(3, 0, `Program ${other} success`)
  Assert.equal(proof(records), false)
})

test("same-slot ordering and unrelated funding do not hide a real vote", () => {
  const records = history(),
    dust = new TransactionMessage({
      payerKey: signer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer,
          toPubkey: buffer,
          lamports: 1
        })
      ]
    }).compileToV0Message()
  records.forEach(record => (record.slot = 1))
  Assert.equal(
    proof([
      records[2],
      records[0],
      {
        transaction: { message: dust },
        meta: { err: null, logMessages: [] }
      },
      records[1]
    ]),
    true
  )
  const late = transaction(2, {
    operator: Keypair.generate().publicKey,
    totalBytes: 99
  })
  late.meta.logMessages[1] = `Program log: opp_outpost: epoch_in late no-op epoch=7 cursor=8`
  Assert.equal(proof([...records, late]), true)
})

test("an indirect target-program invocation is ambiguous evidence", () => {
  const records = history(),
    indirect = transaction(0, { version: 0 }),
    ix = indirect.transaction.message.compiledInstructions[0]
  indirect.meta.innerInstructions = [{ index: 0, instructions: [ix] }]
  indirect.transaction.message.compiledInstructions = []
  Assert.equal(proof([...records, indirect]), false)
  const mixed = history({ version: 0 })
  mixed[2].meta.innerInstructions = [
    {
      index: 0,
      instructions: [mixed[2].transaction.message.compiledInstructions[0]]
    }
  ]
  Assert.equal(proof(mixed), false)
  for (const candidate of [indirect, mixed[2]]) {
    candidate.meta.innerInstructions = null
    candidate.meta.logMessages.unshift(`Program ${programId} invoke [2]`)
    Assert.equal(proof([...records, candidate]), false)
  }
})

test("ambiguous instructions and discarded uploads fail closed", () => {
  const records = history(),
    message = records[0].transaction.message
  message.instructions.push(message.instructions[0])
  Assert.equal(proof(records), false)
  const discarded = history({ version: 0 })
  discarded[1].transaction.message.compiledInstructions[0].data =
    program.coder.instruction.encode("discardEnvelopeChunks", {})
  Assert.equal(proof(discarded), false)
})

test("bounded history reads confirmed transactions serially in chronological order", async () => {
  let active = 0
  const records = history(),
    requests = [],
    connection = {
      getSignaturesForAddress: async (address, options, commitment) => {
        Assert.ok(address.equals(buffer))
        Assert.equal(options.limit, History.SignatureLimit)
        Assert.equal(commitment, "confirmed")
        return [2, 1, 0].map(i => ({ signature: String(i) }))
      },
      getTransaction: async (signature, options) => {
        Assert.equal(++active, 1)
        Assert.equal(options.commitment, "confirmed")
        Assert.equal(options.maxSupportedTransactionVersion, 0)
        requests.push(signature)
        await Promise.resolve()
        active--
        return records[Number(signature)]
      }
    }
  Assert.equal(await History.read(connection, program, accepted, signer), true)
  Assert.deepEqual(requests, ["0", "1", "2"])
  connection.getTransaction = async () => null
  Assert.equal(await History.read(connection, program, accepted, signer), false)
  connection.getSignaturesForAddress = async () =>
    Array(History.SignatureLimit).fill({ signature: "0" })
  Assert.equal(await History.read(connection, program, accepted, signer), false)
  connection.getSignaturesForAddress = async () => []
  Assert.equal(await History.read(connection, program, accepted, signer), false)
})
