import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { createInterface } from "node:readline"
import { ethers } from "ethers"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  Report,
  SolanaCollateralTool,
  WireReserveTool,
  contractView,
  isSolanaProgramRuntimeFailure,
  matchesProtoEnum,
  pollUntil,
  requestEthereumSwap,
  slugValue,
  swapUserOutputKey,
  type ClusterBuildStepOptions,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type SwapScenarioContext
} from "@wireio/cluster-tool"
import { SwapEpochStressScenarioConstants as Constants } from "../SwapEpochStressScenarioConstants.js"
import {
  StressBaselineEpochKey,
  StressBaselineUwreqIdsKey,
  StressRequestSnapshotKey,
  StressSolanaBalancesBeforeKey,
  StressTargetAmountKey,
  stressRequestOutputKey
} from "../SwapEpochStressScenarioOutputs.js"
import {
  SwapEpochStressCheck,
  SwapEpochStressOutcome,
  SwapEpochStressRuntimeFailureKind
} from "../SwapEpochStressScenarioTypes.js"

const { SysioContractName, SysioUwritUnderwriterequeststatus } = SysioContracts
type Uwreq = SysioContracts.SysioUwritUwRequestTType

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStressRoute(request: Uwreq): boolean {
  return (
    slugValue(request.src_chain_code) === Constants.EthereumChainCode &&
    slugValue(request.dst_chain_code) === Constants.SolanaChainCode
  )
}

async function currentEpoch(ctx: SwapScenarioContext): Promise<number> {
  const { rows } = await ctx.wire.getEpochState()
  Assert.ok(rows[0], "sysio.epoch::epochstate is empty")
  return Number(rows[0].current_epoch_index)
}

async function stressRequests(ctx: SwapScenarioContext): Promise<Uwreq[]> {
  const baseline = new Set(ctx.outputs.assert(StressBaselineUwreqIdsKey))
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query()
  return rows.filter(row => !baseline.has(Number(row.id)) && isStressRoute(row))
}

async function observeStressRequests(
  ctx: SwapScenarioContext,
  expectedRequestCount: number,
  signal: AbortSignal
): Promise<void> {
  await pollUntil(
    `${expectedRequestCount} stress UWREQs reach CONFIRMED`,
    async () => {
      signal.throwIfAborted()
      const requests = await stressRequests(ctx),
        confirmedCount = requests.filter(request =>
          matchesProtoEnum(
            request.status,
            SysioUwritUnderwriterequeststatus,
            SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
          )
        ).length
      ctx.outputs.set(StressRequestSnapshotKey, {
        requestIds: requests.map(request => Number(request.id)),
        requestStatuses: requests.map(request => String(request.status)),
        ingestedCount: requests.length,
        confirmedCount
      })
      return (
        requests.length === expectedRequestCount &&
        confirmedCount === expectedRequestCount
      )
    },
    Constants.SettlementDeadlineMs,
    Constants.LongPollIntervalMs
  )
}

/** Typed Step planners and runners used by the swap epoch stress scenario. */
export namespace SwapEpochStressScenarioSteps {
  /** Input used to submit one actor's Ethereum swap request. */
  export interface RequestSwapInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.RequestSwapInput"
    readonly actorIndex: number
  }

  /**
   * Plan one Ethereum-to-Solana swap request.
   *
   * @param actor Report actor responsible for the step.
   * @param name Stable step name.
   * @param description Human-readable step description.
   * @param options Step execution options.
   * @param actorIndex Zero-based actor index.
   * @returns Registered swap-request step.
   */
  export function planRequestSwap(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    actorIndex: number
  ): ClusterBuildStep<SwapScenarioContext, RequestSwapInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      { kind: "SwapEpochStressScenarioSteps.RequestSwapInput", actorIndex },
      runRequestSwap
    )
  }

  /**
   * Submit one source-side swap request using the actor's distinct wallet.
   *
   * @param ctx Flow build context.
   * @param input Swap-request input.
   * @param signal Cooperative cancellation signal.
   * @returns A promise resolved after recording the confirmed request transaction.
   */
  export async function runRequestSwap(
    ctx: SwapScenarioContext,
    input: RequestSwapInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const stressActor = ctx.outputs.assert(swapUserOutputKey(input.actorIndex))
    const targetAmount = ctx.outputs.assert(StressTargetAmountKey)
    const reserveManager = loadReserveManager(ctx, stressActor.ethereumWallet)
    const result = await requestEthereumSwap(reserveManager, {
      sourceTokenCode: BigInt(Constants.EthereumTokenCode),
      sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
      sourceAmountWei: Constants.SourceEthereumWei,
      targetChainCode: BigInt(Constants.SolanaChainCode),
      targetTokenCode: BigInt(Constants.SolanaTokenCode),
      targetReserveCode: BigInt(Constants.PrimaryReserveCode),
      targetRecipient: stressActor.solanaKeypair.publicKey.toBytes(),
      targetAmount,
      targetToleranceBps: Constants.ToleranceBps
    })
    Assert.ok(
      result.transactionHash,
      `actor ${input.actorIndex} has no tx hash`
    )
    ctx.outputs.set(stressRequestOutputKey(input.actorIndex), {
      actorIndex: input.actorIndex,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber
    })
    Report.StepExtraRecorder.note("concurrent swap request submitted", {
      actorIndex: input.actorIndex,
      source: stressActor.ethereumWallet.address,
      recipient: stressActor.solanaKeypair.publicKey.toBase58(),
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      sourceAmountWei: Constants.SourceEthereumWei,
      targetAmount
    })
  }

  /** Input used by the single terminal diagnostic step. */
  export interface DiagnosticInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.DiagnosticInput"
    readonly expectedRequestCount: number
  }

  /** Machine-readable invariant failure included in the terminal diagnosis. */
  export interface FailedCheck {
    readonly check: SwapEpochStressCheck
    readonly expected: string | number
    readonly observed: string | number
    readonly detail: string
  }

  /**
   * Plan the report-first terminal diagnostic step.
   *
   * @param actor Report actor responsible for the step.
   * @param name Stable step name.
   * @param description Human-readable step description.
   * @param options Step execution options.
   * @param expectedRequestCount Expected actor/request count.
   * @returns Registered terminal-diagnostic step.
   */
  export function planTerminalDiagnostics(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    expectedRequestCount: number
  ): ClusterBuildStep<SwapScenarioContext, DiagnosticInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapEpochStressScenarioSteps.DiagnosticInput",
        expectedRequestCount
      },
      runTerminalDiagnostics
    )
  }

  /**
   * Evaluate every stress invariant, observe epoch liveness, and emit one result.
   *
   * @param ctx Flow build context.
   * @param input Terminal-diagnostic input.
   * @param signal Cooperative cancellation signal.
   * @returns A promise resolved only when all invariants pass.
   */
  export async function runTerminalDiagnostics(
    ctx: SwapScenarioContext,
    input: DiagnosticInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const baselineEpoch = ctx.outputs.assert(StressBaselineEpochKey)
    const requiredEpoch =
      baselineEpoch + Constants.RequiredPostLoadEpochAdvances
    let observedEpoch = baselineEpoch
    let epochPollError: unknown = null
    try {
      observedEpoch = await currentEpoch(ctx)
    } catch (error) {
      epochPollError = error
      ctx.log.warn(
        `[SwapEpochStress] initial epoch-state read failed: ${errorMessage(error)}`
      )
    }
    const epochObservations = [
      { epoch: observedEpoch, observedAt: new Date().toISOString() }
    ]
    const actorIndexes = Array.from(
      { length: input.expectedRequestCount },
      (_, actorIndex) => actorIndex
    )
    actorIndexes.forEach(actorIndex => {
      ctx.outputs.assert(swapUserOutputKey(actorIndex))
      ctx.outputs.assert(stressRequestOutputKey(actorIndex))
    })
    let requestObservationError: unknown = null
    try {
      await observeStressRequests(ctx, input.expectedRequestCount, signal)
    } catch (error) {
      requestObservationError = error
      ctx.log.warn(
        `[SwapEpochStress] request lifecycle observation stopped: ${errorMessage(error)}`
      )
    }
    const solanaProgramRuntimeErrors = new Set<string>()
    let programLogReadError: unknown = null
    const scanSolanaProgramLogs = async (): Promise<void> => {
      try {
        const firstActor = ctx.outputs.assert(
          swapUserOutputKey(actorIndexes[0])
        )
        const program = SolanaCollateralTool.loadOppOutpostProgram(
          ctx,
          firstActor.solanaKeypair
        )
        const logs = (
          await ctx.solana.getProgramLogs(program.programId, 100)
        ).flat()
        logs
          .filter(
            line =>
              /memory allocation failed|out of memory|heap(?:[ -]space)? violation/i.test(
                line
              ) || isSolanaProgramRuntimeFailure(line)
          )
          .forEach(line => solanaProgramRuntimeErrors.add(line))
      } catch (error) {
        programLogReadError ??= error
        ctx.log.warn(
          `[SwapEpochStress] Solana program-log read failed: ${errorMessage(error)}`
        )
      }
    }
    await scanSolanaProgramLogs()

    const clusterLogFiles = new Set<string>()
    const seenClusterRuntimeFailureLines = new Set<string>()
    const clusterRuntimeFailureSamples: string[] = []
    const clusterRuntimeFailureKinds: Partial<
      Record<SwapEpochStressRuntimeFailureKind, number>
    > = {}
    let clusterRuntimeFailureCount = 0
    let firstClusterRuntimeFailure = ""
    let lastClusterRuntimeFailure = ""
    let clusterLogReadError: unknown = null
    const scanClusterLogs = async (): Promise<void> => {
      try {
        const logPath = Path.join(ctx.config.clusterPath, "logs")
        const names = (await Fs.promises.readdir(logPath))
          .filter(name => /^cluster_.*\.log$/.test(name))
          .sort()
        names.forEach(name => clusterLogFiles.add(Path.join(logPath, name)))
        for (const file of clusterLogFiles) {
          const lines = createInterface({
            input: Fs.createReadStream(file),
            crlfDelay: Infinity
          })
          for await (const line of lines) {
            const kinds = [
              {
                kind: SwapEpochStressRuntimeFailureKind.SOLANA_MEMORY_FAILURE,
                matches:
                  /memory allocation failed|out of memory|heap(?:[ -]space)? violation/i.test(
                    line
                  )
              },
              {
                kind: SwapEpochStressRuntimeFailureKind.SOLANA_PROGRAM_FAILURE,
                matches: isSolanaProgramRuntimeFailure(line)
              },
              {
                kind: SwapEpochStressRuntimeFailureKind.PROCESS_FATAL_FAILURE,
                matches:
                  /\bfatal\b|segmentation fault|core dumped|panicked at/i.test(
                    line
                  )
              }
            ].filter(candidate => candidate.matches)
            if (kinds.length === 0) continue
            if (seenClusterRuntimeFailureLines.has(line)) continue
            seenClusterRuntimeFailureLines.add(line)
            const evidence = line.slice(
              0,
              Constants.ClusterLogEvidenceMaxLength
            )
            clusterRuntimeFailureCount += 1
            firstClusterRuntimeFailure ||= evidence
            lastClusterRuntimeFailure = evidence
            kinds.forEach(({ kind }) => {
              clusterRuntimeFailureKinds[kind] =
                (clusterRuntimeFailureKinds[kind] ?? 0) + 1
            })
            if (
              clusterRuntimeFailureSamples.length <
              Constants.ClusterLogEvidenceSampleCount
            ) {
              clusterRuntimeFailureSamples.push(evidence)
            }
          }
        }
      } catch (error) {
        clusterLogReadError ??= error
        ctx.log.warn(
          `[SwapEpochStress] aggregate cluster-log read failed: ${errorMessage(error)}`
        )
      }
    }

    const requestSnapshot = ctx.outputs.get(StressRequestSnapshotKey)

    while (observedEpoch < requiredEpoch && epochPollError === null) {
      const previousEpoch = observedEpoch
      try {
        await pollUntil(
          `WIRE epoch advances beyond ${previousEpoch}`,
          async () => {
            signal.throwIfAborted()
            observedEpoch = await currentEpoch(ctx)
            return observedEpoch > previousEpoch
          },
          Constants.epochAdvanceDeadlineMs(),
          Constants.LongPollIntervalMs
        )
        epochObservations.push({
          epoch: observedEpoch,
          observedAt: new Date().toISOString()
        })
        ctx.log.info(
          `[SwapEpochStress] post-load epoch ${observedEpoch}/${requiredEpoch}`
        )
        await scanSolanaProgramLogs()
      } catch (error) {
        epochPollError = error
        ctx.log.warn(
          `[SwapEpochStress] post-load epoch observation stopped: ${errorMessage(error)}`
        )
      }
    }
    await scanSolanaProgramLogs()
    await scanClusterLogs()
    const solanaProgramFailureEvidence = [...solanaProgramRuntimeErrors]
    const targetAmount = ctx.outputs.assert(StressTargetAmountKey)
    const solanaBalancesBefore = ctx.outputs.assert(
      StressSolanaBalancesBeforeKey
    )
    Assert.ok(
      targetAmount <= BigInt(Number.MAX_SAFE_INTEGER),
      "target amount exceeds JavaScript's exact integer range"
    )
    const payoutResults = await Promise.all(
      Array.from(
        { length: input.expectedRequestCount },
        async (_, actorIndex) => {
          const stressActor = ctx.outputs.assert(swapUserOutputKey(actorIndex))
          const balanceBefore = solanaBalancesBefore[actorIndex]
          Assert.ok(
            balanceBefore != null,
            `actor ${actorIndex} has no pre-load Solana balance`
          )
          const expectedMinimum =
            balanceBefore +
            Number(
              targetAmount -
                WireReserveTool.varianceDrift(
                  targetAmount,
                  Constants.ToleranceBps
                )
            )
          try {
            const balance = await ctx.solana.getLamports(
              stressActor.solanaKeypair.publicKey
            )
            return {
              actorIndex,
              recipient: stressActor.solanaKeypair.publicKey.toBase58(),
              before: balanceBefore,
              observed: balance,
              expectedMinimum,
              paid: balance >= expectedMinimum,
              diagnostic: ""
            }
          } catch (error) {
            ctx.log.warn(
              `[SwapEpochStress] actor ${actorIndex} payout balance read failed: ${errorMessage(error)}`
            )
            return {
              actorIndex,
              recipient: stressActor.solanaKeypair.publicKey.toBase58(),
              before: balanceBefore,
              observed: balanceBefore,
              expectedMinimum,
              paid: false,
              diagnostic: errorMessage(error)
            }
          }
        }
      )
    )
    const payoutObservedCount = payoutResults.filter(
      result => result.paid
    ).length
    const payoutDiagnosticFailureCount = payoutResults.filter(
      result => result.diagnostic.length > 0
    ).length
    const failedChecks: FailedCheck[] = []
    if (requestSnapshot?.ingestedCount !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.UWREQ_INGESTION_FAILED,
        expected: input.expectedRequestCount,
        observed: requestSnapshot?.ingestedCount ?? 0,
        detail:
          "WIRE did not create exactly one new ETH→SOL UWREQ per submitted load request"
      })
    }
    if (requestSnapshot?.confirmedCount !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.UNDERWRITING_FAILED,
        expected: input.expectedRequestCount,
        observed: requestSnapshot?.confirmedCount ?? 0,
        detail: "not every new UWREQ reached CONFIRMED"
      })
    }
    if (payoutObservedCount !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.DESTINATION_SETTLEMENT_FAILED,
        expected: input.expectedRequestCount,
        observed: payoutObservedCount,
        detail: "not every Solana recipient received the complete quoted payout"
      })
    }
    if (epochPollError !== null || observedEpoch < requiredEpoch) {
      failedChecks.push({
        check: SwapEpochStressCheck.EPOCH_LIVENESS_FAILED,
        expected: `epoch >= ${requiredEpoch}`,
        observed: `epoch ${observedEpoch}`,
        detail: "WIRE did not complete the required post-load epoch soak"
      })
    }
    if (
      solanaProgramFailureEvidence.length > 0 ||
      clusterRuntimeFailureCount > 0
    ) {
      failedChecks.push({
        check: SwapEpochStressCheck.CHAIN_RUNTIME_FAILED,
        expected: "no high-confidence runtime failure evidence",
        observed:
          `${solanaProgramFailureEvidence.length} committed-program lines; ` +
          `${clusterRuntimeFailureCount} aggregate-log lines`,
        detail:
          "one or more chain processes or programs reported a fatal, panic, memory, or terminal execution failure"
      })
    }
    if (
      requestSnapshot == null ||
      requestObservationError !== null ||
      payoutDiagnosticFailureCount > 0 ||
      programLogReadError !== null ||
      clusterLogReadError !== null
    ) {
      failedChecks.push({
        check: SwapEpochStressCheck.DIAGNOSTIC_COLLECTION_FAILED,
        expected: "all terminal diagnostic sources readable",
        observed: [
          requestSnapshot != null
            ? "UWREQ lifecycle snapshot available"
            : "UWREQ lifecycle snapshot unavailable",
          requestObservationError === null
            ? "request observation completed"
            : "request observation failed",
          `${payoutDiagnosticFailureCount} payout balance read failures`,
          programLogReadError === null
            ? "program logs readable"
            : "program logs unreadable",
          clusterLogReadError === null
            ? "cluster logs readable"
            : "cluster logs unreadable"
        ].join("; "),
        detail: "the flow could not collect every required diagnostic source"
      })
    }

    const outcome =
      failedChecks.length === 0
        ? SwapEpochStressOutcome.SWAP_EPOCH_STRESS_COMPLETED
        : SwapEpochStressOutcome.SWAP_EPOCH_STRESS_FAILED
    const runtimeFailureKindSummary =
      Object.entries(clusterRuntimeFailureKinds)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(",") || "none"
    const resultSummary =
      `actors ${input.expectedRequestCount}/${input.expectedRequestCount}; ` +
      `requests submitted ${input.expectedRequestCount}/${input.expectedRequestCount}; ` +
      `UWREQs ingested ${requestSnapshot?.ingestedCount ?? 0}/${input.expectedRequestCount}; ` +
      `UWREQs confirmed ${requestSnapshot?.confirmedCount ?? 0}/${input.expectedRequestCount}; ` +
      `payouts completed ${payoutObservedCount}/${input.expectedRequestCount}; ` +
      `epoch ${observedEpoch}/${requiredEpoch}; ` +
      `runtime failure lines ${clusterRuntimeFailureCount}; ` +
      `runtime failure kinds ${runtimeFailureKindSummary}`
    const diagnosis = {
      outcome,
      resultSummary,
      failedCheckCount: failedChecks.length,
      failedChecks,
      runtimeFailureKinds: clusterRuntimeFailureKinds
    }

    Report.StepExtraRecorder.note("post-load terminal diagnostics", {
      diagnosis,
      baselineEpoch,
      observedEpoch,
      requiredEpoch,
      epochObservationCount: epochObservations.length,
      epochObservations,
      expectedRequestCount: input.expectedRequestCount,
      provisionedActorCount: input.expectedRequestCount,
      submittedRequestCount: input.expectedRequestCount,
      observedRequestCount: requestSnapshot?.ingestedCount ?? 0,
      confirmedRequestCount: requestSnapshot?.confirmedCount ?? 0,
      requestIds: requestSnapshot?.requestIds ?? [],
      requestStatuses: requestSnapshot?.requestStatuses ?? [],
      requestObservationError:
        requestObservationError instanceof Error
          ? requestObservationError.message
          : String(requestObservationError ?? ""),
      payoutObservedCount,
      payoutDiagnosticFailureCount,
      payoutResults,
      epochPollError:
        epochPollError instanceof Error
          ? epochPollError.message
          : String(epochPollError ?? ""),
      solanaProgramFailureEvidence,
      solanaProgramLogReadError:
        programLogReadError instanceof Error
          ? programLogReadError.message
          : String(programLogReadError ?? ""),
      clusterLogFiles: [...clusterLogFiles],
      clusterRuntimeFailureCount,
      clusterRuntimeFailureKinds,
      firstClusterRuntimeFailure,
      lastClusterRuntimeFailure,
      clusterRuntimeFailureSamples,
      clusterLogReadError:
        clusterLogReadError instanceof Error
          ? clusterLogReadError.message
          : String(clusterLogReadError ?? "")
    })

    Assert.strictEqual(
      failedChecks.length,
      0,
      `${outcome}: ${resultSummary}; failed checks: ${failedChecks
        .map(failure => `${failure.check} (${failure.detail})`)
        .join(", ")}`
    )
  }

  function loadReserveManager(
    ctx: SwapScenarioContext,
    wallet: ethers.Signer
  ): ReserveManagerRequestSwapContract {
    const address = EthereumCollateralTool.loadOutpostAddresses(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    )[Constants.ReserveManagerContractName]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `${Constants.ReserveManagerContractName} missing from outpost-addrs.json`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    )
    return contractView<ReserveManagerRequestSwapContract>(address, abi, wallet)
  }
}
