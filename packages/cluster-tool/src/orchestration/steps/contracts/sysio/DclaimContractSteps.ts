import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import {
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
  type DistributionClaimBootstrapSource
} from "../../../outputs/DistributionClaimBootstrap.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.dclaim` (distribution claims) actions. */
export namespace DclaimContractSteps {
  /** Compact per-chain totals copied into every batch's report input. */
  export interface ImportSeedChainSummary {
    readonly sources: readonly DistributionClaimBootstrapSource[]
    readonly eligibleAddressCount: number
    readonly batchCount: number
    readonly totalAtomic: string
    readonly droppedDust: string
  }

  /**
   * Compact input for one `importseed` Step. The bulk payload remains in
   * `ctx.outputs` and is selected by chain plus batch index at run time.
   */
  export interface ImportSeedBatchInput extends StepInput {
    readonly kind: "DclaimContractSteps.ImportSeedBatchInput"
    readonly chain: ImportSeedChainKind
    readonly batchIndex: number
    readonly creditCount: number
    readonly summary: ImportSeedChainSummary
  }

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
    creditCount: number,
    summary: ImportSeedChainSummary
  ): ClusterBuildStep<C, ImportSeedBatchInput> {
    return ClusterBuildStep.create<C, ImportSeedBatchInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "DclaimContractSteps.ImportSeedBatchInput",
        chain,
        batchIndex,
        creditCount,
        summary
      },
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
    const dclaim = ctx.wire.getSysioContract(SysioContractName.dclaim)
    const nextUnmappedId = await readNextUnmappedId(ctx)
    try {
      await dclaim.actions.importseed.invokeViaFile(
        serializeBatchForClio(batch),
        { retryFinality: false, retryTransport: false }
      )
    } catch (error) {
      if (
        (await isIrreversibleFinalityError(ctx, error)) &&
        (await isImportSeedBatchApplied(ctx, batch, nextUnmappedId))
      )
        return
      throw error
    }
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
      await dclaim.actions.importdone.invoke(
        {},
        { retryFinality: false, retryTransport: false }
      )
    } catch (error) {
      const { rows } = await dclaim.tables.capcfg
        .query({ limit: 1 })
        .catch(error => {
          ctx.log.warn(
            `dclaim importdone reconciliation query failed: ${errorMessage(error)}`
          )
          return { rows: [], more: false }
        })
      if (
        rows[0]?.imported_complete &&
        (await isIrreversibleFinalityError(ctx, error))
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
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .tables.unmapped.query({
        lowerBound: firstUnmappedId,
        limit: batch.credits.length
      })
      .catch(error => {
        ctx.log.warn(
          `dclaim importseed reconciliation query failed: ${errorMessage(error)}`
        )
        return { rows: [], more: false }
      })
    const rowsByAddress = new Map(
      rows
        .filter(row => isExpectedChainKind(row.chain_kind, expectedChain))
        .map(row => [row.native_pubkey, row])
    )
    return batch.credits.every(credit => {
      const row = rowsByAddress.get(credit.native_address)
      return row?.balance === formatWireAsset(credit.wire_atomic)
    })
  }

  async function isIrreversibleFinalityError<
    C extends ClusterBuildContext
  >(ctx: C, error: unknown): Promise<boolean> {
    if (!(error instanceof WireClient.TransactionFinalityError)) return false
    return ctx.wire
      .isTransactionIrreversible(
        error.transactionId,
        error.observedBlockNum
      )
      .catch(proofError => {
        ctx.log.warn(
          `dclaim transaction finality reconciliation failed: ${errorMessage(proofError)}`
        )
        return false
      })
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
