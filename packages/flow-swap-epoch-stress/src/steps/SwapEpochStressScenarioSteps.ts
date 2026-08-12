import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { createInterface } from "node:readline"
import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  EthereumOutpostBootstrapper,
  Report,
  SolanaCollateralTool,
  contractView,
  matchesProtoEnum,
  pollUntil,
  requestEthereumSwap,
  slugValue,
  type ClusterBuildStepOptions,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type SwapScenarioContext
} from "@wireio/cluster-tool"
import { SwapEpochStressScenarioConstants as Constants } from "../SwapEpochStressScenarioConstants.js"
import {
  StressBaselineEpochKey,
  StressBaselineUwreqIdsKey,
  StressTargetAmountKey,
  stressActorOutputKey,
  stressRequestOutputKey
} from "../SwapEpochStressScenarioOutputs.js"
import {
  SwapEpochStressCheck,
  SwapEpochStressOutcome,
  SwapEpochStressRuntimeFailureKind
} from "../SwapEpochStressScenarioTypes.js"

const { SysioContractName, SysioUwritUnderwriterequeststatus } = SysioContracts
type Uwreq = SysioContracts.SysioUwritUwRequestTType

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
    .tables.uwreqs.query({ limit: 256 })
  return rows.filter(row => !baseline.has(Number(row.id)) && isStressRoute(row))
}

export namespace SwapEpochStressScenarioSteps {
  export interface ProvisionActorInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.ProvisionActorInput"
    readonly actorIndex: number
    readonly ethereumHdIndex: number
  }

  export function planProvisionActor(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    actorIndex: number,
    ethereumHdIndex: number
  ): ClusterBuildStep<SwapScenarioContext, ProvisionActorInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapEpochStressScenarioSteps.ProvisionActorInput",
        actorIndex,
        ethereumHdIndex
      },
      runProvisionActor
    )
  }

  export async function runProvisionActor(
    ctx: SwapScenarioContext,
    input: ProvisionActorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const derivation = `${EthereumOutpostBootstrapper.DerivationPath}${input.ethereumHdIndex}`
    const ethereumWallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(EthereumOutpostBootstrapper.AnvilMnemonic),
      derivation
    ).connect(ctx.ethereum.provider)
    const solanaKeypair = Keypair.generate()
    const solanaBalanceBefore = await ctx.solana.getLamports(
      solanaKeypair.publicKey
    )
    Report.StepExtraRecorder.note("created distinct stress actor", {
      actorIndex: input.actorIndex,
      ethereumHdIndex: input.ethereumHdIndex,
      ethereumAddress: ethereumWallet.address,
      solanaRecipient: solanaKeypair.publicKey.toBase58(),
      solanaBalanceBefore
    })
    ctx.outputs.set(stressActorOutputKey(input.actorIndex), {
      actorIndex: input.actorIndex,
      ethereumWallet,
      solanaKeypair,
      solanaBalanceBefore
    })
  }

  export interface RequestSwapInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.RequestSwapInput"
    readonly actorIndex: number
  }

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

  export async function runRequestSwap(
    ctx: SwapScenarioContext,
    input: RequestSwapInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const stressActor = ctx.outputs.assert(
      stressActorOutputKey(input.actorIndex)
    )
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

  export interface VerifyPayoutInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.VerifyPayoutInput"
    readonly actorIndex: number
  }

  export function planVerifyPayout(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    actorIndex: number
  ): ClusterBuildStep<SwapScenarioContext, VerifyPayoutInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      { kind: "SwapEpochStressScenarioSteps.VerifyPayoutInput", actorIndex },
      runVerifyPayout
    )
  }

  export async function runVerifyPayout(
    ctx: SwapScenarioContext,
    input: VerifyPayoutInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const stressActor = ctx.outputs.assert(
      stressActorOutputKey(input.actorIndex)
    )
    const targetAmount = ctx.outputs.assert(StressTargetAmountKey)
    Assert.ok(
      targetAmount <= BigInt(Number.MAX_SAFE_INTEGER),
      "target amount exceeds JavaScript's exact integer range"
    )
    const expectedMinimum =
      stressActor.solanaBalanceBefore + Number(targetAmount)
    let observed = stressActor.solanaBalanceBefore
    await pollUntil(
      `actor ${input.actorIndex} SOL payout`,
      async () => {
        signal.throwIfAborted()
        observed = await ctx.solana.getLamports(
          stressActor.solanaKeypair.publicKey
        )
        return observed >= expectedMinimum
      },
      Constants.SettlementDeadlineMs,
      Constants.LongPollIntervalMs
    )
    Report.StepExtraRecorder.note("destination payout observed", {
      actorIndex: input.actorIndex,
      recipient: stressActor.solanaKeypair.publicKey.toBase58(),
      before: stressActor.solanaBalanceBefore,
      observed,
      expectedMinimum
    })
  }

  export interface DiagnosticInput extends StepInput {
    readonly kind: "SwapEpochStressScenarioSteps.DiagnosticInput"
    readonly expectedRequestCount: number
  }

  export interface FailedCheck {
    readonly check: SwapEpochStressCheck
    readonly expected: string | number
    readonly observed: string | number
    readonly detail: string
  }

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
    let epochPollError: unknown
    try {
      observedEpoch = await currentEpoch(ctx)
    } catch (error) {
      epochPollError = error
    }
    const epochObservations = [
      { epoch: observedEpoch, observedAt: new Date().toISOString() }
    ]
    const provisionedActorIndexes = Array.from(
      { length: input.expectedRequestCount },
      (_, actorIndex) => actorIndex
    ).filter(actorIndex => ctx.outputs.has(stressActorOutputKey(actorIndex)))
    const submittedRequestCount = provisionedActorIndexes.filter(actorIndex =>
      ctx.outputs.has(stressRequestOutputKey(actorIndex))
    ).length
    const solanaProgramRuntimeErrors = new Set<string>()
    let programLogReadError: unknown
    const scanSolanaProgramLogs = async (): Promise<void> => {
      const firstActorIndex = provisionedActorIndexes[0]
      if (firstActorIndex == null) {
        programLogReadError ??= new Error(
          "no provisioned Solana actor is available for program-log diagnostics"
        )
        return
      }
      try {
        const firstActor = ctx.outputs.assert(
          stressActorOutputKey(firstActorIndex)
        )
        const program = SolanaCollateralTool.loadOppOutpostProgram(
          ctx,
          firstActor.solanaKeypair
        )
        const logs = (
          await ctx.solana.getProgramLogs(program.programId, 100)
        ).flat()
        logs
          .filter(line =>
            /memory allocation failed|out of memory|heap(?:[ -]space)? violation|SBF program panicked|ProgramFailedToComplete/i.test(
              line
            )
          )
          .forEach(line => solanaProgramRuntimeErrors.add(line))
      } catch (error) {
        programLogReadError ??= error
      }
    }
    await scanSolanaProgramLogs()

    const clusterLogFiles: string[] = []
    const clusterRuntimeFailureSamples: string[] = []
    const clusterRuntimeFailureKinds: Partial<
      Record<SwapEpochStressRuntimeFailureKind, number>
    > = {}
    let clusterRuntimeFailureCount = 0
    let firstClusterRuntimeFailure = ""
    let lastClusterRuntimeFailure = ""
    let clusterLogReadError: unknown
    const scanClusterLogs = async (): Promise<void> => {
      try {
        const logPath = Path.join(ctx.config.clusterPath, "logs")
        const names = (await Fs.promises.readdir(logPath))
          .filter(name => /^cluster_.*\.log$/.test(name))
          .sort()
        clusterLogFiles.push(...names.map(name => Path.join(logPath, name)))
        for (const file of clusterLogFiles) {
          const lines = createInterface({
            input: Fs.createReadStream(file),
            crlfDelay: Infinity
          })
          for await (const line of lines) {
            const kinds = [
              {
                kind: SwapEpochStressRuntimeFailureKind.solanaMemory,
                matches:
                  /memory allocation failed|out of memory|heap(?:[ -]space)? violation/i.test(
                    line
                  )
              },
              {
                kind: SwapEpochStressRuntimeFailureKind.solanaProgram,
                matches: /SBF program panicked|ProgramFailedToComplete/i.test(
                  line
                )
              },
              {
                kind: SwapEpochStressRuntimeFailureKind.processFatal,
                matches:
                  /\bfatal\b|segmentation fault|core dumped|panicked at/i.test(
                    line
                  )
              }
            ].filter(candidate => candidate.matches)
            if (kinds.length === 0) continue
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
      }
    }
    while (observedEpoch < requiredEpoch && epochPollError === undefined) {
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
      }
    }

    let requests: Uwreq[] = []
    let requestReadError: unknown
    try {
      requests = await stressRequests(ctx)
    } catch (error) {
      requestReadError = error
    }
    const confirmed = requests.filter(request =>
      matchesProtoEnum(
        request.status,
        SysioUwritUnderwriterequeststatus,
        SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
      )
    )
    await scanSolanaProgramLogs()
    await scanClusterLogs()
    const solanaProgramFailureEvidence = [...solanaProgramRuntimeErrors]
    const targetAmount = ctx.outputs.assert(StressTargetAmountKey)
    Assert.ok(
      targetAmount <= BigInt(Number.MAX_SAFE_INTEGER),
      "target amount exceeds JavaScript's exact integer range"
    )
    const payoutResults = await Promise.all(
      Array.from(
        { length: input.expectedRequestCount },
        async (_, actorIndex) => {
          if (!ctx.outputs.has(stressActorOutputKey(actorIndex))) {
            return {
              actorIndex,
              recipient: "",
              before: 0,
              observed: 0,
              expectedMinimum: Number(targetAmount),
              paid: false,
              diagnostic: "actor was not provisioned"
            }
          }
          const stressActor = ctx.outputs.assert(
            stressActorOutputKey(actorIndex)
          )
          try {
            const balance = await ctx.solana.getLamports(
              stressActor.solanaKeypair.publicKey
            )
            const expectedMinimum =
              stressActor.solanaBalanceBefore + Number(targetAmount)
            return {
              actorIndex,
              recipient: stressActor.solanaKeypair.publicKey.toBase58(),
              before: stressActor.solanaBalanceBefore,
              observed: balance,
              expectedMinimum,
              paid: balance >= expectedMinimum,
              diagnostic: ""
            }
          } catch (error) {
            return {
              actorIndex,
              recipient: stressActor.solanaKeypair.publicKey.toBase58(),
              before: stressActor.solanaBalanceBefore,
              observed: stressActor.solanaBalanceBefore,
              expectedMinimum:
                stressActor.solanaBalanceBefore + Number(targetAmount),
              paid: false,
              diagnostic: error instanceof Error ? error.message : String(error)
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
    if (provisionedActorIndexes.length !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.actorProvisioning,
        expected: input.expectedRequestCount,
        observed: provisionedActorIndexes.length,
        detail: "not every source/destination actor was provisioned"
      })
    }
    if (submittedRequestCount !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.requestSubmission,
        expected: input.expectedRequestCount,
        observed: submittedRequestCount,
        detail:
          "not every concurrent Ethereum requestSwap transaction succeeded"
      })
    }
    if (requests.length !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.uwreqIngestion,
        expected: input.expectedRequestCount,
        observed: requests.length,
        detail:
          "WIRE did not create exactly one new ETH→SOL UWREQ per submitted load request"
      })
    }
    if (confirmed.length !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.underwriting,
        expected: input.expectedRequestCount,
        observed: confirmed.length,
        detail: "not every new UWREQ reached CONFIRMED"
      })
    }
    if (payoutObservedCount !== input.expectedRequestCount) {
      failedChecks.push({
        check: SwapEpochStressCheck.destinationSettlement,
        expected: input.expectedRequestCount,
        observed: payoutObservedCount,
        detail: "not every Solana recipient received the complete quoted payout"
      })
    }
    if (epochPollError !== undefined || observedEpoch < requiredEpoch) {
      failedChecks.push({
        check: SwapEpochStressCheck.epochLiveness,
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
        check: SwapEpochStressCheck.chainRuntime,
        expected: "no high-confidence runtime failure evidence",
        observed:
          `${solanaProgramFailureEvidence.length} committed-program lines; ` +
          `${clusterRuntimeFailureCount} aggregate-log lines`,
        detail:
          "one or more chain processes or programs reported a fatal, panic, memory, or terminal execution failure"
      })
    }
    if (
      requestReadError !== undefined ||
      payoutDiagnosticFailureCount > 0 ||
      programLogReadError !== undefined ||
      clusterLogReadError !== undefined
    ) {
      failedChecks.push({
        check: SwapEpochStressCheck.diagnosticCollection,
        expected: "all terminal diagnostic sources readable",
        observed: [
          requestReadError === undefined
            ? "UWREQ table readable"
            : "UWREQ table unreadable",
          `${payoutDiagnosticFailureCount} payout balance read failures`,
          programLogReadError === undefined
            ? "program logs readable"
            : "program logs unreadable",
          clusterLogReadError === undefined
            ? "cluster logs readable"
            : "cluster logs unreadable"
        ].join("; "),
        detail: "the flow could not collect every required diagnostic source"
      })
    }

    const outcome =
      failedChecks.length === 0
        ? SwapEpochStressOutcome.completed
        : SwapEpochStressOutcome.failed
    const runtimeFailureKindSummary =
      Object.entries(clusterRuntimeFailureKinds)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(",") || "none"
    const resultSummary =
      `actors ${provisionedActorIndexes.length}/${input.expectedRequestCount}; ` +
      `requests submitted ${submittedRequestCount}/${input.expectedRequestCount}; ` +
      `UWREQs ingested ${requests.length}/${input.expectedRequestCount}; ` +
      `UWREQs confirmed ${confirmed.length}/${input.expectedRequestCount}; ` +
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
      provisionedActorCount: provisionedActorIndexes.length,
      submittedRequestCount,
      observedRequestCount: requests.length,
      confirmedRequestCount: confirmed.length,
      requestIds: requests.map(request => Number(request.id)),
      requestStatuses: requests.map(request => String(request.status)),
      requestReadError:
        requestReadError instanceof Error
          ? requestReadError.message
          : String(requestReadError ?? ""),
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
      clusterLogFiles,
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
