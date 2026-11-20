import type { BorshInstructionCoder } from "@coral-xyz/anchor"
import {
  MessageAccountKeys,
  PublicKey,
  type Connection,
  type VersionedTransactionResponse
} from "@solana/web3.js"
import { ethers } from "ethers"

import {
  SolanaClient,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool
} from "@wireio/cluster-tool"

import type { BatchRosterReplacementScenario } from "./BatchRosterReplacementScenario.js"

type Program = ReturnType<typeof SolanaOutpostProgramTool.loadReadOnlyProgram>
interface Chunk {
  epochIndex: number
  chunkIndex: number
  totalChunks: number
  totalBytes: number
  chunkData: Buffer
}

/** Durable proof of the replacement's canonical vote after settled-tally cleanup. */
export namespace SolanaDeliveryHistory {
  /** One bounded RPC page; a full page is incomplete evidence and fails closed. */
  export const SignatureLimit = 1000
  /** Program seed for the buffer scoped to one epoch and one signing operator. */
  const ChunkBufferSeed = "envelope_chunks"
  /** Phase-A program marker identifying calls that cannot mutate the buffer. */
  const LateNoopLogPrefix = "Program log: opp_outpost: epoch_in late no-op "
  /** Finalizer marker identifying a newly recorded vote rather than a retry. */
  const FreshVoteLogSuffix = " consensus_retry=false"
  /** Program ABI instruction names as converted by Anchor's deployed IDL loader. */
  enum Instruction {
    EpochIn = "epochIn",
    Discard = "discardEnvelopeChunks"
  }

  /**
   * Read a complete bounded history serially to respect the validator's RPC limit.
   * @param connection - The destination's RPC connection.
   * @param program - The deployed program and its generated instruction coder.
   * @param accepted - The canonical accepted envelope for a completed epoch.
   * @param signer - The replacement operator's signing public key.
   * @returns Whether confirmed transactions prove the exact canonical delivery.
   */
  export async function read(
    connection: Connection,
    program: Program,
    accepted: BatchRosterReplacementScenario.EnvelopeRecord,
    signer: PublicKey
  ): Promise<boolean> {
    const { buffer } = addresses(
        program.programId,
        accepted.epochIndex,
        signer
      ),
      signatures = await connection.getSignaturesForAddress(
        buffer,
        { limit: SignatureLimit },
        SolanaClient.ConfirmationStatus.confirmed
      ),
      transactions: VersionedTransactionResponse[] = []
    if (!signatures.length || signatures.length === SignatureLimit) return false
    for (const { signature } of signatures.toReversed()) {
      const transaction = await connection.getTransaction(signature, {
        commitment: SolanaClient.ConfirmationStatus.confirmed,
        maxSupportedTransactionVersion: 0
      })
      // Pruned or missing transactions cannot establish a complete upload history.
      if (!transaction?.meta) return false
      transactions.push(transaction)
    }
    return provesDelivery(transactions, program, accepted, signer)
  }

  /**
   * Reconstruct actual chunk writes and require a fresh, successful finalization.
   * @param transactions - Complete confirmed buffer history, including same-slot calls.
   * @param program - The deployed IDL, coder and program identity.
   * @param accepted - The full canonical envelope checksum and epoch.
   * @param signer - The operator that must have signed and finalized the upload.
   * @returns False for partial, conflicting, discarded, failed or ambiguous evidence.
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
      chunks = new Map<number, Buffer>()
    let geometry: Chunk,
      finalized = false
    for (const response of transactions) {
      if (!response?.meta) return false
      if (response.meta.err) continue
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
        return false
      if (!instructions.length) continue
      if (instructions.length !== 1) return false
      const [instruction] = instructions,
        decoded = (program.coder.instruction as BorshInstructionCoder).decode(
          Buffer.from(instruction.data)
        )
      if (!decoded) return false
      if (decoded.name === Instruction.Discard) return false
      if (decoded.name !== Instruction.EpochIn) continue
      const logs = directLogs(response.meta.logMessages, program.programId)
      // Phase A returns before authorization or buffer access for closed epochs.
      if (logs.some(line => line.startsWith(LateNoopLogPrefix))) continue
      const accounts = program.idl.instructions.find(
          ix => ix.name === Instruction.EpochIn
        )?.accounts,
        accountIndex = (name: string) =>
          instruction.accountKeyIndexes[
            accounts?.findIndex(a => a.name === name)
          ],
        operatorIndex = accountIndex("operator"),
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
        return false
      if (
        geometry &&
        (chunk.totalChunks !== geometry.totalChunks ||
          chunk.totalBytes !== geometry.totalBytes)
      )
        return false
      geometry = chunk
      const writeLog = `Program log: opp_outpost: epoch_in chunk op=${signer} epoch=${chunk.epochIndex} chunk=${chunk.chunkIndex}/${chunk.totalChunks} bytes=${chunk.chunkData.length}`
      if (logs.includes(writeLog)) {
        if (
          chunks.has(chunk.chunkIndex) ||
          chunk.chunkIndex >= chunk.totalChunks
        )
          return false
        chunks.set(chunk.chunkIndex, Buffer.from(chunk.chunkData))
      }
      if (
        logs.some(
          line =>
            line.startsWith(
              `Program log: opp_outpost: epoch_in finalize epoch=${chunk.epochIndex} operator=${signer} digest=`
            ) && line.endsWith(FreshVoteLogSuffix)
        )
      ) {
        if (
          finalized ||
          chunk.chunkIndex !== chunk.totalChunks ||
          chunk.chunkData.length !== 0
        )
          return false
        finalized = true
      }
    }
    const ordered = [...chunks.entries()].sort(([a], [b]) => a - b)
    return (
      finalized &&
      chunks.size === geometry.totalChunks &&
      ordered.every(([index], position) => index === position) &&
      ordered.reduce((sum, [, data]) => sum + data.length, 0) ===
        geometry.totalBytes &&
      accepted.checksum.length === ethers.dataLength(ethers.ZeroHash) &&
      ethers.keccak256(Buffer.concat(ordered.map(([, data]) => data))) ===
        ethers.hexlify(Uint8Array.from(accepted.checksum))
    )
  }

  /** Derive the protocol's epoch and operator-scoped evidence addresses. */
  function addresses(programId: PublicKey, epoch: number, signer: PublicKey) {
    const index = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT)
    index.writeUInt32LE(epoch)
    return {
      buffer: SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(ChunkBufferSeed),
        index,
        signer.toBuffer()
      ),
      tally: SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.EpochDeliveries),
        index
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
