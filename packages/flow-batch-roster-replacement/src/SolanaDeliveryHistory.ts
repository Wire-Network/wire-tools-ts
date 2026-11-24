import type { BorshInstructionCoder } from "@coral-xyz/anchor"
import {
  MessageAccountKeys,
  PublicKey,
  type Connection,
  type VersionedTransactionResponse
} from "@solana/web3.js"
import { ethers } from "ethers"

import {
  getLogger,
  readTransactionHistory,
  SolanaClient,
  SolanaHistoryRpcError,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool
} from "@wireio/cluster-tool"

import type { BatchRosterReplacementScenario } from "./BatchRosterReplacementScenario.js"

const log = getLogger(__filename)

type Program = ReturnType<typeof SolanaOutpostProgramTool.loadReadOnlyProgram>
interface Chunk {
  epochIndex: number
  chunkIndex: number
  totalChunks: number
  totalBytes: number
  chunkData: Buffer
}
interface UploadInstruction {
  signature: string
  slot: number
  chunk: Chunk
  logs: string[]
}

/** Durable proof of the replacement's canonical vote after settled-tally cleanup. */
export namespace SolanaDeliveryHistory {
  /** Allow a full first signature page while bounding an epoch poll to two pages. */
  export const HistoryMaxPages = 2
  /** Phase-A program marker identifying calls that cannot mutate the buffer. */
  const LateNoopLogPrefix = "Program log: opp_outpost: epoch_in late no-op "
  /** Finalizer marker identifying a newly recorded vote rather than a retry. */
  const NewVoteLogSuffix = " consensus_retry=false"
  /** Program ABI instruction names as converted by Anchor's deployed IDL loader. */
  enum Instruction {
    epochIn = "epochIn",
    discardEnvelopeChunks = "discardEnvelopeChunks"
  }

  /**
   * Read a complete bounded history serially to respect the validator's RPC limit.
   * @param connection - The destination's RPC connection.
   * @param program - The deployed program and its generated instruction coder.
   * @param accepted - The canonical accepted envelope for a completed epoch.
   * @param signer - The replacement operator's signing public key.
   * @returns Whether finalized transactions prove the exact canonical delivery.
   */
  export async function read(
    connection: Connection,
    program: Program,
    accepted: BatchRosterReplacementScenario.EnvelopeRecord,
    signer: PublicKey
  ): Promise<boolean> {
    const { buffer } = addresses(program.programId, accepted.epochIndex, signer)
    let transactions: VersionedTransactionResponse[]
    try {
      transactions = await readTransactionHistory(
        connection,
        buffer,
        SolanaClient.ConfirmationStatus.finalized,
        HistoryMaxPages
      )
    } catch (error) {
      if (!(error instanceof SolanaHistoryRpcError)) throw error
      log.warn(
        `Solana delivery history RPC unavailable: epoch=${accepted.epochIndex} operator=${signer} ${error.message}`
      )
      return false
    }
    // The shared reader logs the requested signature for missing transaction data.
    if (!transactions) return false
    if (!transactions.length)
      return reject(
        `no finalized buffer history: epoch=${accepted.epochIndex} operator=${signer} buffer=${buffer}`
      )
    log.debug(
      `Checking finalized delivery history: epoch=${accepted.epochIndex} operator=${signer} buffer=${buffer} transactions=${transactions.length}`
    )
    return provesDelivery(transactions, program, accepted, signer)
  }

  /**
   * Reconstruct actual chunk writes and require a fresh, successful finalization.
   * @param transactions - Complete finalized buffer history, including same-slot calls.
   * @param program - The deployed IDL, coder and program identity.
   * @param accepted - The full canonical envelope checksum and epoch.
   * @param signer - The operator that must have signed and finalized the upload.
   * @returns Whether one complete upload proves the canonical vote without mixing discarded bytes.
   */
  export function provesDelivery(
    transactions: VersionedTransactionResponse[],
    program: Program,
    accepted: BatchRosterReplacementScenario.EnvelopeRecord,
    signer: PublicKey
  ): boolean {
    const { buffer, tally } = addresses(
        program.programId,
        accepted.epochIndex,
        signer
      ),
      uploadInstructions: UploadInstruction[] = [],
      discardSlots = new Set<number>()
    for (const response of transactions) {
      const signature = response?.transaction?.signatures?.[0]
      if (!response?.meta)
        return reject("transaction metadata unavailable", signature)
      if (response.meta.err) {
        log.debug(
          `Ignoring failed delivery transaction: signature=${signature ?? "unavailable"}`
        )
        continue
      }
      const { message } = response.transaction,
        keys = new MessageAccountKeys(
          message.staticAccountKeys,
          response.meta.loadedAddresses
        ),
        instructions = message.compiledInstructions.filter(ix =>
          keys.get(ix.programIdIndex)?.equals(program.programId)
        )
      // A single direct invocation makes instruction/log attribution unambiguous.
      if (
        response.meta.logMessages?.some(
          line =>
            line.startsWith(`Program ${program.programId} invoke [`) &&
            line !== `Program ${program.programId} invoke [1]`
        ) ||
        response.meta.innerInstructions?.some(group =>
          group.instructions.some(ix =>
            keys.get(ix.programIdIndex)?.equals(program.programId)
          )
        )
      )
        return reject(
          "indirect program invocation prevents log attribution",
          signature
        )
      if (!instructions.length) continue
      if (instructions.length !== 1)
        return reject(
          "multiple direct program instructions prevent log attribution",
          signature
        )
      const [instruction] = instructions,
        decoded = (program.coder.instruction as BorshInstructionCoder).decode(
          Buffer.from(instruction.data)
        )
      if (!decoded)
        return reject(
          "instruction cannot be decoded by deployed IDL",
          signature
        )
      const accounts = program.idl.instructions.find(
          ix => ix.name === decoded.name
        )?.accounts,
        accountIndex = (name: string) =>
          instruction.accountKeyIndexes[
            accounts?.findIndex(a => a.name === name)
          ]
      if (decoded.name === Instruction.discardEnvelopeChunks) {
        const uploaderIndex = accountIndex("uploader")
        if (
          !keys.get(uploaderIndex)?.equals(signer) ||
          !message.isAccountSigner(uploaderIndex) ||
          !keys.get(accountIndex("chunkBuffer"))?.equals(buffer) ||
          (decoded.data as Pick<Chunk, "epochIndex">).epochIndex !==
            accepted.epochIndex ||
          !Number.isSafeInteger(response.slot) ||
          response.slot < 0
        )
          return reject(
            "discard uploader, signature, buffer, epoch or slot does not match",
            signature
          )
        discardSlots.add(response.slot)
        continue
      }
      if (decoded.name !== Instruction.epochIn) continue
      const logs = directLogs(response.meta.logMessages, program.programId)
      // Phase A returns before authorization or buffer access for closed epochs.
      if (logs.some(line => line.startsWith(LateNoopLogPrefix))) continue
      const operatorIndex = accountIndex("operator"),
        chunk = decoded.data as Chunk
      if (
        !keys.get(operatorIndex)?.equals(signer) ||
        !message.isAccountSigner(operatorIndex) ||
        !keys.get(accountIndex("epochDeliveries"))?.equals(tally) ||
        !keys.get(accountIndex("chunkBuffer"))?.equals(buffer) ||
        chunk.epochIndex !== accepted.epochIndex ||
        !Number.isSafeInteger(chunk.totalBytes) ||
        chunk.totalBytes <= 0 ||
        !Number.isSafeInteger(chunk.totalChunks) ||
        chunk.totalChunks <= 0
      )
        return reject(
          "upload signer, PDA, epoch or chunk geometry does not match",
          signature
        )
      uploadInstructions.push({ signature, slot: response.slot, chunk, logs })
    }
    const boundaries = [...discardSlots].sort((a, b) => a - b),
      uploads: UploadInstruction[][] = Array.from(
        { length: boundaries.length + 1 },
        () => []
      )
    for (const instruction of uploadInstructions) {
      // RPC ordering within a slot cannot establish which side of a discard wrote bytes.
      if (
        boundaries.length &&
        (!Number.isSafeInteger(instruction.slot) ||
          instruction.slot < 0 ||
          discardSlots.has(instruction.slot))
      )
        return reject(
          `upload slot is unavailable or shares discard slot ${instruction.slot}`,
          instruction.signature
        )
      uploads[
        boundaries.findLastIndex(slot => slot < instruction.slot) + 1
      ].push(instruction)
    }
    // Discard closes staging bytes; it does not erase an already-recorded vote.
    return uploads.some(upload => provesUpload(upload, accepted, signer))
  }

  /** Verify one upload without borrowing chunks from discarded attempts. */
  function provesUpload(
    instructions: UploadInstruction[],
    accepted: BatchRosterReplacementScenario.EnvelopeRecord,
    signer: PublicKey
  ): boolean {
    const chunks = new Map<number, Buffer>()
    let geometry: Chunk,
      finalized = false,
      finalizerSignature: string
    for (const instruction of instructions) {
      const { chunk, logs, signature } = instruction
      if (
        geometry &&
        (chunk.totalChunks !== geometry.totalChunks ||
          chunk.totalBytes !== geometry.totalBytes)
      )
        return reject("chunk geometry changed within one upload", signature)
      geometry = chunk
      const writeLog = `Program log: opp_outpost: epoch_in chunk op=${signer} epoch=${chunk.epochIndex} chunk=${chunk.chunkIndex}/${chunk.totalChunks} bytes=${chunk.chunkData.length}`
      if (logs.includes(writeLog)) {
        if (
          chunks.has(chunk.chunkIndex) ||
          chunk.chunkIndex >= chunk.totalChunks
        )
          return reject(
            `duplicate or out-of-range chunk index ${chunk.chunkIndex}`,
            signature
          )
        chunks.set(chunk.chunkIndex, Buffer.from(chunk.chunkData))
      }
      if (
        logs.some(
          line =>
            line.startsWith(
              `Program log: opp_outpost: epoch_in finalize epoch=${chunk.epochIndex} operator=${signer} digest=`
            ) && line.endsWith(NewVoteLogSuffix)
        )
      ) {
        if (
          finalized ||
          chunk.chunkIndex !== chunk.totalChunks ||
          chunk.chunkData.length !== 0
        )
          return reject("duplicate or malformed new-vote finalizer", signature)
        finalized = true
        finalizerSignature = signature
      }
    }
    const signature = finalizerSignature ?? instructions.at(-1)?.signature,
      ordered = [...chunks.entries()].sort(([a], [b]) => a - b)
    if (!finalized)
      return reject(
        "new-vote finalization marker absent (consensus_retry=false)",
        signature
      )
    if (chunks.size !== geometry.totalChunks)
      return reject("upload has missing chunks", signature)
    if (!ordered.every(([index], position) => index === position))
      return reject("chunk indexes are not contiguous", signature)
    if (
      ordered.reduce((sum, [, data]) => sum + data.length, 0) !==
      geometry.totalBytes
    )
      return reject(
        "uploaded byte count differs from chunk geometry",
        signature
      )
    if (accepted.checksum.length !== ethers.dataLength(ethers.ZeroHash))
      return reject("canonical checksum is not 32 bytes", signature)
    if (
      ethers.keccak256(Buffer.concat(ordered.map(([, data]) => data))) !==
      ethers.hexlify(Uint8Array.from(accepted.checksum))
    )
      return reject("canonical envelope checksum mismatch", signature)
    return true
  }

  /** Keep rejection reasons and transaction provenance in the flow's debug log. */
  function reject(reason: string, signature?: string): false {
    log.debug(
      `Solana delivery proof rejected: ${reason}; signature=${signature ?? "unavailable"}`
    )
    return false
  }

  /** Derive the protocol's epoch and operator-scoped evidence addresses. */
  function addresses(programId: PublicKey, epoch: number, signer: PublicKey) {
    const index = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT)
    index.writeUInt32LE(epoch)
    return {
      buffer: SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.EnvelopeChunks),
        index,
        signer.toBuffer()
      ),
      tally: SolanaOutpostProgramTool.derivePda(
        programId,
        ...SolanaOutpostBootstrapper.createEpochDeliveriesSeeds(epoch)
      )
    }
  }

  /** Exclude nested CPI messages, which cannot testify to the direct instruction. */
  function directLogs(logs: string[], programId: PublicKey): string[] {
    const stack: string[] = [],
      result: string[] = []
    for (const line of logs ?? []) {
      const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line)
      if (invoke) stack.push(invoke[1])
      else if (/^Program \w+ (success|failed:)/.test(line)) stack.pop()
      else if (stack.length === 1 && stack[0] === programId.toBase58())
        result.push(line)
    }
    return result
  }
}
