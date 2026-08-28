import Assert from "node:assert"
import Crypto from "node:crypto"
import Fs from "node:fs/promises"
import Path from "node:path"

import { z } from "zod"

import { SysioContracts } from "@wireio/sdk-core"

import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import {
  ImportSeedChainKindSchema,
  serializeBatchForClio,
  type ImportSeedBatch,
  type ImportSeedChainKind
} from "../../../../tools/wire/WireDclaimSeedTool.js"
import { formatWireAsset } from "../../../../tools/wire/WireUserTool.js"
import { abiEnumValue } from "../../../../utils/enumUtils.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import {
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapSourceSchema
} from "../../../outputs/DistributionClaimBootstrapOutput.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.dclaim` (distribution claims) actions. */
export namespace DclaimContractSteps {
  /** Decimal non-negative-integer text carried in compact report inputs. */
  const DecimalIntegerPattern = /^\d+$/
  /** Canonical positive decimal text used for deterministic row identities. */
  const PositiveDecimalIntegerPattern = /^[1-9]\d*$/

  /** Runtime schema for compact per-chain totals copied into every batch's report input. */
  export const ImportSeedChainSummarySchema = z.object({
    sources: z.array(DistributionClaimBootstrapSourceSchema),
    eligibleAddressCount: z.number().safe().int().positive(),
    batchCount: z.number().safe().int().positive(),
    totalAtomic: z.string().regex(DecimalIntegerPattern),
    droppedDust: z.string().regex(DecimalIntegerPattern)
  })
  /** Compact per-chain totals — the shape of {@link ImportSeedChainSummarySchema}. */
  export type ImportSeedChainSummary = z.infer<
    typeof ImportSeedChainSummarySchema
  >

  /**
   * Runtime schema for one compact `importseed` Step input. The bulk payload
   * remains in `ctx.outputs` and is selected by chain plus batch index at run
   * time.
   */
  export const ImportSeedBatchInputSchema = z.object({
    kind: z.literal("DclaimContractSteps.ImportSeedBatchInput"),
    chain: ImportSeedChainKindSchema,
    batchIndex: z.number().safe().int().nonnegative(),
    firstUnmappedId: z.string().regex(PositiveDecimalIntegerPattern),
    creditCount: z.number().safe().int().positive(),
    summary: ImportSeedChainSummarySchema
  })
  /** Compact `importseed` Step input — the shape of {@link ImportSeedBatchInputSchema}. */
  export type ImportSeedBatchInput = z.infer<typeof ImportSeedBatchInputSchema>

  /**
   * Runtime schema for one durable, compact pending-submission marker.
   * A null expiry is intentionally permanent: it means the process could have
   * died before learning when clio signed, so an automatic retry is unsafe.
   */
  const PendingImportSeedJournalSchema = z.object({
    kind: z.literal("DclaimContractSteps.PendingImportSeed"),
    chain: ImportSeedChainKindSchema,
    batchIndex: z.number().safe().int().nonnegative(),
    firstUnmappedId: z.string().regex(PositiveDecimalIntegerPattern),
    creditCount: z.number().safe().int().positive(),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAfterChainTimeMs: z.number().safe().int().nonnegative().nullable()
  })
  type PendingImportSeedJournal = z.infer<
    typeof PendingImportSeedJournalSchema
  >

  /** `sysio.dclaim::setconfig` — initialize the `cap_config` singleton (idempotent). */
  export function planSetconfig<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runSetconfig
    )
  }

  /** Named runner — `sysio.dclaim::setconfig` (empty payload). */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.setconfig.invoke({})
  }

  /**
   * Plan one `sysio.dclaim::importseed` action using a compact output reference.
   *
   * @param actor - Report actor responsible for the action.
   * @param name - Step report name.
   * @param description - Step report description.
   * @param options - Retry, timeout, and scheduling options.
   * @param chain - Native chain selecting the prepared output.
   * @param batchIndex - Zero-based batch index within that chain.
   * @param firstUnmappedId - Deterministic first row id assigned to the batch.
   * @param creditCount - Expected batch size, checked at execution time.
   * @param summary - Compact chain-level aggregate report fields.
   * @returns The planned import Step.
   */
  export function planImportSeedBatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: ImportSeedChainKind,
    batchIndex: number,
    firstUnmappedId: string,
    creditCount: number,
    summary: ImportSeedChainSummary
  ): ClusterBuildStep<C, ImportSeedBatchInput> {
    const input = ImportSeedBatchInputSchema.parse({
      kind: "DclaimContractSteps.ImportSeedBatchInput",
      chain,
      batchIndex,
      firstUnmappedId,
      creditCount,
      summary
    })
    return ClusterBuildStep.create<C, ImportSeedBatchInput>(
      actor,
      name,
      description,
      options,
      input,
      runImportSeedBatch
    )
  }

  /**
   * Resolve and push one prepared `importseed` batch.
   *
   * @param ctx - Cluster build context containing the finalized bootstrap.
   * @param input - Compact chain/index reference to the bulk output.
   * @param signal - Cancellation signal checked before external work.
   * @returns A promise that resolves once the contract action succeeds.
   */
  export async function runImportSeedBatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportSeedBatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chainResult = ctx.outputs
      .assert(DistributionClaimBootstrapResultKey)
      .chains.find(candidate => candidate.chain === input.chain)
    Assert.ok(
      chainResult != null,
      `distribution-claim bootstrap chain missing: ${input.chain}`
    )
    const batch = chainResult.batches[input.batchIndex]
    Assert.ok(
      batch != null,
      `distribution-claim bootstrap batch missing: chain=${input.chain}, index=${input.batchIndex}`
    )
    Assert.equal(
      batch.credits.length,
      input.creditCount,
      `distribution-claim bootstrap batch size changed: chain=${input.chain}, index=${input.batchIndex}`
    )
    const dclaim = ctx.wire.getSysioContract(SysioContractName.dclaim),
      journalPath = pendingImportSeedJournalPath(ctx, input),
      nextUnmappedId = await readNextUnmappedId(ctx),
      expectedFirstUnmappedId = BigInt(input.firstUnmappedId),
      liveNextUnmappedId = BigInt(nextUnmappedId)
    if (liveNextUnmappedId < expectedFirstUnmappedId) {
      throw new Error(
        `dclaim importseed batch cannot run before its deterministic range: ` +
          `chain=${input.chain}, batch=${input.batchIndex}, ` +
          `expected_first_id=${input.firstUnmappedId}, live_next_id=${nextUnmappedId}`
      )
    }
    if (liveNextUnmappedId > expectedFirstUnmappedId) {
      if (
        await isObservedStateIrreversible(
          ctx,
          () => isImportSeedBatchApplied(ctx, batch, input.firstUnmappedId),
          "importseed preflight"
        )
      ) {
        await removePendingImportSeedJournal(journalPath)
        return
      }
      throw new Error(
        `dclaim importseed counter advanced past an unreconciled batch: ` +
          `chain=${input.chain}, batch=${input.batchIndex}, ` +
          `expected_first_id=${input.firstUnmappedId}, live_next_id=${nextUnmappedId}`
      )
    }

    const existingJournal = await readPendingImportSeedJournal(journalPath)
    if (existingJournal != null) {
      assertPendingImportSeedJournalMatches(input, batch, existingJournal)
      if (
        await waitForPendingImportSeedResolution(
          ctx,
          batch,
          input,
          existingJournal,
          signal
        )
      ) {
        await removePendingImportSeedJournal(journalPath)
        return
      }
      await removePendingImportSeedJournal(journalPath)
      return runImportSeedBatch(ctx, input, signal)
    }

    const pendingJournal: PendingImportSeedJournal = {
      kind: "DclaimContractSteps.PendingImportSeed",
      chain: input.chain,
      batchIndex: input.batchIndex,
      firstUnmappedId: input.firstUnmappedId,
      creditCount: input.creditCount,
      payloadSha256: importSeedPayloadSha256(batch),
      expiresAfterChainTimeMs: null
    }
    await writePendingImportSeedJournal(journalPath, pendingJournal)
    try {
      await dclaim.actions.importseed.invokeViaFileOnce(
        serializeBatchForClio(batch)
      )
      await removePendingImportSeedJournal(journalPath)
    } catch (error) {
      if (
        await isActionAppliedIrreversibly(
          ctx,
          error,
          () => isImportSeedBatchApplied(ctx, batch, input.firstUnmappedId),
          "importseed"
        )
      ) {
        await removePendingImportSeedJournal(journalPath)
        return
      }
      const boundedJournal = await boundPendingImportSeedExpiration(
        ctx,
        journalPath,
        pendingJournal
      )
      if (
        await waitForPendingImportSeedResolution(
          ctx,
          batch,
          input,
          boundedJournal,
          signal
        )
      ) {
        await removePendingImportSeedJournal(journalPath)
        return
      }
      await removePendingImportSeedJournal(journalPath)
      throw error
    }
  }

  async function waitForPendingImportSeedResolution<
    C extends ClusterBuildContext
  >(
    ctx: C,
    batch: ImportSeedBatch,
    input: ImportSeedBatchInput,
    journal: PendingImportSeedJournal,
    signal: AbortSignal
  ): Promise<boolean> {
    while (true) {
      signal.throwIfAborted()
      if (
        await isObservedStateIrreversible(
          ctx,
          () => isImportSeedBatchApplied(ctx, batch, input.firstUnmappedId),
          "pending importseed"
        )
      )
        return true

      if (journal.expiresAfterChainTimeMs == null)
        throw new Error(
          `Pending importseed submission has no safe expiration bound: ` +
            `chain=${input.chain}, batch=${input.batchIndex}`
        )
      const info = await ctx.wire.getInfo()
      if (
        parseChainTime(info.head_block_time) >
        journal.expiresAfterChainTimeMs
      )
        return false
      await ctx.wire.waitForHeadToAdvance()
    }
  }

  function pendingImportSeedJournalPath<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportSeedBatchInput
  ): string {
    return Path.join(
      ctx.config.dataPath,
      `.dclaim-importseed-${input.chain}-${input.batchIndex}-${input.firstUnmappedId}.pending.json`
    )
  }

  async function readPendingImportSeedJournal(
    journalPath: string
  ): Promise<PendingImportSeedJournal | null> {
    try {
      return PendingImportSeedJournalSchema.parse(
        JSON.parse(await Fs.readFile(journalPath, "utf8"))
      )
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null
      throw error
    }
  }

  async function writePendingImportSeedJournal(
    journalPath: string,
    journal: PendingImportSeedJournal
  ): Promise<void> {
    await writeAndSyncFile(journalPath, JSON.stringify(journal))
    await syncParentDirectory(journalPath)
  }

  async function boundPendingImportSeedExpiration<
    C extends ClusterBuildContext
  >(
    ctx: C,
    journalPath: string,
    journal: PendingImportSeedJournal
  ): Promise<PendingImportSeedJournal> {
    // clio has returned and can no longer sign a transaction. Sampling chain
    // time now therefore gives a conservative upper bound for any transaction
    // it may have submitted; a crash before this replacement leaves null and
    // remains fail-closed.
    const info = await ctx.wire.getInfo(),
      boundedJournal: PendingImportSeedJournal = {
        ...journal,
        expiresAfterChainTimeMs:
          parseChainTime(info.head_block_time) +
          WireClient.TransactionExpirationSec * 1_000
      },
      temporaryPath = `${journalPath}.${Crypto.randomUUID()}.tmp`
    try {
      await writeAndSyncFile(temporaryPath, JSON.stringify(boundedJournal))
      await Fs.rename(temporaryPath, journalPath)
      await syncParentDirectory(journalPath)
      return boundedJournal
    } finally {
      try {
        await Fs.unlink(temporaryPath)
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error
      }
    }
  }

  async function writeAndSyncFile(path: string, value: string): Promise<void> {
    const file = await Fs.open(path, "wx", 0o600)
    try {
      await file.writeFile(value, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
  }

  async function syncParentDirectory(path: string): Promise<void> {
    const directory = await Fs.open(Path.dirname(path), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async function removePendingImportSeedJournal(
    journalPath: string
  ): Promise<void> {
    try {
      await Fs.unlink(journalPath)
      await syncParentDirectory(journalPath)
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error
    }
  }

  function assertPendingImportSeedJournalMatches(
    input: ImportSeedBatchInput,
    batch: ImportSeedBatch,
    journal: PendingImportSeedJournal
  ): void {
    Assert.equal(journal.chain, input.chain, "pending importseed chain changed")
    Assert.equal(
      journal.batchIndex,
      input.batchIndex,
      "pending importseed batch index changed"
    )
    Assert.equal(
      journal.firstUnmappedId,
      input.firstUnmappedId,
      "pending importseed first row id changed"
    )
    Assert.equal(
      journal.creditCount,
      input.creditCount,
      "pending importseed credit count changed"
    )
    Assert.equal(
      journal.payloadSha256,
      importSeedPayloadSha256(batch),
      "pending importseed payload changed"
    )
  }

  function importSeedPayloadSha256(batch: ImportSeedBatch): string {
    return Crypto.createHash("sha256")
      .update(JSON.stringify(serializeBatchForClio(batch)))
      .digest("hex")
  }

  function parseChainTime(value: string): number {
    const milliseconds = Date.parse(`${value.replace(/Z$/, "")}Z`)
    Assert.ok(Number.isFinite(milliseconds), `invalid chain time: ${value}`)
    return milliseconds
  }

  function nodeErrorCode(error: unknown): string | null {
    return typeof error === "object" && error != null && "code" in error
      ? String(error.code)
      : null
  }

  /**
   * Plan `sysio.dclaim::importdone`, closing the import window exactly once.
   *
   * @param actor - Report actor responsible for the action.
   * @param name - Step report name.
   * @param description - Step report description.
   * @param options - Retry, timeout, and scheduling options.
   * @returns The planned import-completion Step.
   */
  export function planImportDone<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runImportDone
    )
  }

  /**
   * Invoke `sysio.dclaim::importdone` with its empty payload.
   *
   * @param ctx - Cluster build context used to reach `sysio.dclaim`.
   * @param _input - Empty action input.
   * @param signal - Cancellation signal checked before external work.
   * @returns A promise that resolves once the contract action succeeds.
   */
  export async function runImportDone<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const dclaim = ctx.wire.getSysioContract(SysioContractName.dclaim)
    try {
      await dclaim.actions.importdone.invokeOnce({})
    } catch (error) {
      if (
        await isActionAppliedIrreversibly(
          ctx,
          error,
          () => isImportComplete(ctx),
          "importdone"
        )
      )
        return
      throw error
    }
  }

  async function readNextUnmappedId<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<string> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .tables.capcounters.query({ limit: 1 })
    return String(rows[0]?.next_unmapped_id ?? 1)
  }

  async function isImportSeedBatchApplied<C extends ClusterBuildContext>(
    ctx: C,
    batch: ImportSeedBatch,
    firstUnmappedId: string
  ): Promise<boolean> {
    const expectedChain = abiChainKind(batch.chain)
    try {
      const dclaim = ctx.wire.getSysioContract(SysioContractName.dclaim),
        endUnmappedId = (
          BigInt(firstUnmappedId) + BigInt(batch.credits.length)
        ).toString(),
        readPage = async (
          lowerBound: string,
          accumulated: SysioContracts.SysioDclaimUnmappedTokenType[]
        ): Promise<SysioContracts.SysioDclaimUnmappedTokenType[]> => {
          const page = await dclaim.tables.unmapped.query({
              lowerBound,
              upperBound: unmappedIdBound(endUnmappedId),
              limit: Math.max(batch.credits.length - accumulated.length, 1)
            }),
            rows = [...accumulated, ...page.rows]
          if (!page.more || rows.length >= batch.credits.length) return rows
          Assert.ok(
            page.nextKey != null,
            "dclaim importseed reconciliation page omitted next_key"
          )
          Assert.notEqual(
            page.nextKey,
            lowerBound,
            "dclaim importseed reconciliation next_key did not advance"
          )
          return readPage(page.nextKey, rows)
        },
        rows = await readPage(unmappedIdBound(firstUnmappedId), []),
        rowsByAddress = new Map(
          rows
            .filter(row => isExpectedChainKind(row.chain_kind, expectedChain))
            .map(row => [row.native_pubkey, row])
        )
      return batch.credits.every(credit => {
        const row = rowsByAddress.get(credit.native_address)
        return row?.balance === formatWireAsset(credit.wire_atomic)
      })
    } catch (error) {
      ctx.log.warn(
        `dclaim importseed reconciliation query failed: ${errorMessage(error)}`
      )
      return false
    }
  }

  async function isImportComplete<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean> {
    try {
      const { rows } = await ctx.wire
        .getSysioContract(SysioContractName.dclaim)
        .tables.capcfg.query({ limit: 1 })
      return Boolean(rows[0]?.imported_complete)
    } catch (error) {
      ctx.log.warn(
        `dclaim importdone reconciliation query failed: ${errorMessage(error)}`
      )
      return false
    }
  }

  async function isIrreversibleFinalityError<C extends ClusterBuildContext>(
    ctx: C,
    error: unknown
  ): Promise<boolean> {
    if (!(error instanceof WireClient.TransactionFinalityError)) return false
    try {
      return await ctx.wire.isTransactionIrreversible(
        error.transactionId,
        error.observedBlockNum
      )
    } catch (proofError) {
      ctx.log.warn(
        `dclaim transaction finality reconciliation failed: ${errorMessage(proofError)}`
      )
      return false
    }
  }

  async function isActionAppliedIrreversibly<
    C extends ClusterBuildContext
  >(
    ctx: C,
    error: unknown,
    isApplied: () => Promise<boolean>,
    action: string
  ): Promise<boolean> {
    if (error instanceof WireClient.TransactionFinalityError)
      return (
        (await isIrreversibleFinalityError(ctx, error)) && (await isApplied())
      )
    return isObservedStateIrreversible(ctx, isApplied, action)
  }

  async function isObservedStateIrreversible<
    C extends ClusterBuildContext
  >(
    ctx: C,
    isApplied: () => Promise<boolean>,
    action: string
  ): Promise<boolean> {
    if (!(await isApplied())) return false
    try {
      const observedHead = await ctx.wire.getInfo()
      if (
        !(await ctx.wire.waitForBlockIrreversible({
          blockNum: observedHead.head_block_num,
          blockId: observedHead.head_block_id
        }))
      )
        return false
      return await isApplied()
    } catch (proofError) {
      ctx.log.warn(
        `dclaim ${action} state-finality reconciliation failed: ${errorMessage(proofError)}`
      )
      return false
    }
  }

  function unmappedIdBound(id: string): string {
    Assert.match(id, DecimalIntegerPattern, `invalid dclaim unmapped id: ${id}`)
    return JSON.stringify({ id })
  }

  function abiChainKind(
    chain: ImportSeedChainKind
  ): SysioContracts.SysioDclaimChainkind {
    return abiEnumValue(SysioContracts.SysioDclaimChainkind, chain)
  }

  function isExpectedChainKind(
    actual:
      | SysioContracts.SysioDclaimChainkind
      | keyof typeof SysioContracts.SysioDclaimChainkind,
    expected: SysioContracts.SysioDclaimChainkind
  ): boolean {
    return (
      actual === expected ||
      actual === SysioContracts.SysioDclaimChainkind[expected]
    )
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
