const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { test, after, afterEach, mock } = require("node:test")
const {
  Keypair,
  PublicKey,
  AddressLookupTableAccount,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram
} = require("@solana/web3.js")
const { ethers } = require("ethers")
const {
  getLogger,
  readSignaturesSince,
  SolanaOutpostProgramTool
} = require("@wireio/cluster-tool")
const {
  SolanaDeliveryHistory: History
} = require("../lib/SolanaDeliveryHistory.js")
const log = getLogger(require.resolve("../lib/SolanaDeliveryHistory.js"))
afterEach(() => mock.restoreAll())

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
        accounts: [
          { name: "uploader", signer: true },
          { name: "chunk_buffer" }
        ],
        args: [{ name: "epoch_index", type: "u32" }]
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
      signatures: [`signature-${index}`],
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
function discard(overrides = {}) {
  const {
      uploader = signer,
      signed = true,
      chunkBuffer = buffer,
      epoch = epochIndex,
      slot = 5,
      version = "legacy"
    } = overrides,
    instruction = new TransactionInstruction({
      programId,
      keys: [uploader, chunkBuffer].map((pubkey, index) => ({
        pubkey,
        isSigner: index === 0 && signed,
        isWritable: true
      })),
      data: program.coder.instruction.encode("discardEnvelopeChunks", {
        epochIndex: epoch
      })
    }),
    message = new TransactionMessage({
      payerKey: signed ? uploader : Keypair.generate().publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [instruction]
    })
  return {
    slot,
    transaction: {
      signatures: ["discard-signature"],
      message:
        version === "legacy"
          ? message.compileToLegacyMessage()
          : message.compileToV0Message()
    },
    meta: {
      err: null,
      logMessages: [
        `Program ${programId} invoke [1]`,
        `Program ${programId} success`
      ]
    }
  }
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

test("a complete canonical upload finalized only as a consensus retry is not a new vote", () => {
  const records = history()
  records[2].meta.logMessages[1] = records[2].meta.logMessages[1].replace(
    "consensus_retry=false",
    "consensus_retry=true"
  )
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

test("ambiguous instructions and invalid discards fail closed", () => {
  const records = history(),
    message = records[0].transaction.message
  message.instructions.push(message.instructions[0])
  Assert.equal(proof(records), false)
  const discarded = history({ version: 0 })
  discarded[1].transaction.message.compiledInstructions[0].data =
    program.coder.instruction.encode("discardEnvelopeChunks", { epochIndex })
  Assert.equal(proof(discarded), false)
})

for (const version of ["legacy", 0])
  test(`a rejected upload can be discarded and canonically re-uploaded (${version})`, () => {
    const rejected = history({ version }),
      corrected = history({ version }),
      wrong = Buffer.from(parts[0])
    wrong[0] ^= 1
    rejected[0] = transaction(0, { version, chunkData: wrong })
    rejected[2].meta.err = { InstructionError: [0, "Custom"] }
    corrected.forEach(record => (record.slot = 6))
    Assert.equal(
      proof([
        corrected[2],
        rejected[1],
        discard({ version }),
        corrected[0],
        rejected[2],
        corrected[1],
        rejected[0]
      ]),
      true
    )
  })

test("discarding a buffer does not erase an earlier canonical vote", () => {
  const later = transaction(0, { totalBytes: 999 })
  later.slot = 6
  Assert.equal(proof([...history(), discard(), later]), true)
})

test("chunks on opposite sides of a discard cannot be combined", () => {
  for (const split of [1, 2]) {
    const records = history()
    records.slice(split).forEach(record => (record.slot += 10))
    Assert.equal(proof([...records, discard()]), false)
  }
})

test("a discard boundary requires the exact uploader, signature, epoch and buffer", () => {
  for (const overrides of [
    { uploader: Keypair.generate().publicKey },
    { signed: false },
    { epoch: epochIndex + 1 },
    { chunkBuffer: Keypair.generate().publicKey }
  ])
    Assert.equal(proof([...history(), discard(overrides)]), false)
})

test("failed discards do not reset upload evidence", () => {
  const failed = discard(),
    corrected = history()
  failed.meta.err = { InstructionError: [0, "Custom"] }
  Assert.equal(proof([...history(), failed]), true)
  corrected.forEach(record => (record.slot += 10))
  Assert.equal(proof([transaction(0), failed, ...corrected]), false)
})

test("discard and mutating upload calls in one slot are ambiguous", () => {
  const boundary = discard({ slot: 2 })
  Assert.equal(proof([...history(), boundary]), false)
  Assert.equal(proof([boundary, ...history().toReversed()]), false)
  boundary.slot = undefined
  Assert.equal(proof([...history(), boundary]), false)
  const late = transaction(2, {
    operator: Keypair.generate().publicKey,
    totalBytes: 99
  })
  late.slot = 5
  late.meta.logMessages[1] = `Program log: opp_outpost: epoch_in late no-op epoch=7 cursor=8`
  Assert.equal(proof([...history(), discard(), late]), true)
})

test("multiple discarded attempts remain separate from a final canonical upload", () => {
  const corrected = history(),
    middle = transaction(1)
  corrected.forEach(record => (record.slot += 10))
  middle.slot = 7
  Assert.equal(
    proof([
      transaction(0),
      discard(),
      middle,
      discard({ slot: 8 }),
      ...corrected
    ]),
    true
  )
})

test("a complete canonical upload remains provable across a full signature page", async () => {
  const dustMessage = new TransactionMessage({
      payerKey: signer,
      recentBlockhash: signer.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer,
          toPubkey: buffer,
          lamports: 1
        })
      ]
    }).compileToV0Message(),
    records = [
      ...history(),
      ...Array.from(
        { length: readSignaturesSince.PageSize - 2 },
        (_, index) => ({
          slot: 10,
          transaction: { message: dustMessage, signatures: [`dust-${index}`] },
          meta: { err: null, logMessages: [] }
        })
      )
    ],
    newest = records.toReversed(),
    connection = {
      getSignaturesForAddress: async (_address, options) => {
        const start =
          options.before == null
            ? 0
            : newest.findIndex(
                record => record.transaction.signatures[0] === options.before
              ) + 1
        return newest
          .slice(start, start + options.limit)
          .map(record => ({ signature: record.transaction.signatures[0] }))
      },
      getTransaction: async signature =>
        records.find(record => record.transaction.signatures[0] === signature)
    }
  Assert.equal(records.length, 1001)
  Assert.equal(await History.read(connection, program, accepted, signer), true)
})

for (const operation of ["getSignaturesForAddress", "getTransaction"])
  test(`a failed ${operation} RPC warns and retries successfully on the next read`, async () => {
    const records = history(),
      connection = {
        getSignaturesForAddress: async () =>
          records
            .toReversed()
            .map(record => ({ signature: record.transaction.signatures[0] })),
        getTransaction: async signature =>
          records.find(record => record.transaction.signatures[0] === signature)
      },
      original = connection[operation],
      warning = mock.method(log, "warn", () => {})
    connection[operation] = async () => {
      throw new Error("connection reset")
    }
    Assert.equal(
      await History.read(connection, program, accepted, signer),
      false
    )
    Assert.match(warning.mock.calls[0].arguments[0], /connection reset/)
    connection[operation] = original
    Assert.equal(
      await History.read(connection, program, accepted, signer),
      true
    )
  })

test("history limits and decoder errors stay visible instead of becoming RPC retries", async () => {
  const warning = mock.method(log, "warn", () => {}),
    connection = {
      getSignaturesForAddress: async () =>
        Array.from({ length: readSignaturesSince.PageSize }, (_, index) => ({
          signature: String(index),
          slot: 1
        })),
      getTransaction: async () => transaction(0)
    }
  await Assert.rejects(
    History.read(connection, program, accepted, signer),
    /runs past 2 pages/
  )
  connection.getSignaturesForAddress = async () => [
    { signature: "signature-0" }
  ]
  const error = new Error("invalid deployed instruction coder"),
    invalid = {
      programId: program.programId,
      idl: program.idl,
      coder: {
        instruction: {
          decode: () => {
            throw error
          }
        }
      }
    }
  await Assert.rejects(
    History.read(connection, invalid, accepted, signer),
    candidate => candidate === error
  )
  Assert.equal(warning.mock.callCount(), 0)
})

test("structural and checksum rejections identify their reason and transaction signature", () => {
  const debug = mock.method(log, "debug", () => {}),
    wrong = [...checksum]
  wrong[31] ^= 1
  Assert.equal(proof(history(), { ...accepted, checksum: wrong }), false)
  Assert.match(
    debug.mock.calls.at(-1).arguments[0],
    /checksum mismatch.*signature=signature-2/
  )
  const records = history()
  records[0].meta = null
  Assert.equal(proof(records), false)
  Assert.match(
    debug.mock.calls.at(-1).arguments[0],
    /metadata unavailable.*signature=signature-0/
  )
})
