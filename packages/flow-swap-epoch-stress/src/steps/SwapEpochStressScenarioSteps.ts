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
  stressActorOutputKey
} from "../SwapEpochStressScenarioOutputs.js"

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
    let observedEpoch = await currentEpoch(ctx)
    const epochObservations = [
      { epoch: observedEpoch, observedAt: new Date().toISOString() }
    ]
    const firstActor = ctx.outputs.assert(stressActorOutputKey(0))
    const program = SolanaCollateralTool.loadOppOutpostProgram(
      ctx,
      firstActor.solanaKeypair
    )
    const memoryErrors = new Set<string>()
    let programLogReadError: unknown
    const scanSolanaProgramLogs = async (): Promise<void> => {
      try {
        const logs = (
          await ctx.solana.getProgramLogs(program.programId, 100)
        ).flat()
        logs
          .filter(line =>
            /memory allocation failed|out of memory|heap(?:[ -]space)? violation/i.test(
              line
            )
          )
          .forEach(line => memoryErrors.add(line))
      } catch (error) {
        programLogReadError ??= error
      }
    }
    await scanSolanaProgramLogs()

    const clusterLogFiles: string[] = []
    const clusterMemoryFailureSamples: string[] = []
    let clusterMemoryFailureCount = 0
    let firstClusterMemoryFailure = ""
    let lastClusterMemoryFailure = ""
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
            if (
              !/memory allocation failed|out of memory|heap(?:[ -]space)? violation/i.test(
                line
              )
            ) {
              continue
            }
            const evidence = line.slice(
              0,
              Constants.ClusterLogEvidenceMaxLength
            )
            clusterMemoryFailureCount += 1
            firstClusterMemoryFailure ||= evidence
            lastClusterMemoryFailure = evidence
            if (
              clusterMemoryFailureSamples.length <
              Constants.ClusterLogEvidenceSampleCount
            ) {
              clusterMemoryFailureSamples.push(evidence)
            }
          }
        }
      } catch (error) {
        clusterLogReadError ??= error
      }
    }
    let epochPollError: unknown
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

    const requests = await stressRequests(ctx)
    const confirmed = requests.filter(request =>
      matchesProtoEnum(
        request.status,
        SysioUwritUnderwriterequeststatus,
        SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
      )
    )
    await scanSolanaProgramLogs()
    await scanClusterLogs()
    const solanaMemoryErrors = [...memoryErrors]
    const targetAmount = ctx.outputs.assert(StressTargetAmountKey)
    Assert.ok(
      targetAmount <= BigInt(Number.MAX_SAFE_INTEGER),
      "target amount exceeds JavaScript's exact integer range"
    )
    const payoutResults = await Promise.all(
      Array.from(
        { length: input.expectedRequestCount },
        async (_, actorIndex) => {
          const stressActor = ctx.outputs.assert(
            stressActorOutputKey(actorIndex)
          )
          const balance = await ctx.solana.getLamports(
            stressActor.solanaKeypair.publicKey
          )
          return {
            actorIndex,
            recipient: stressActor.solanaKeypair.publicKey.toBase58(),
            before: stressActor.solanaBalanceBefore,
            observed: balance,
            paid:
              balance >= stressActor.solanaBalanceBefore + Number(targetAmount)
          }
        }
      )
    )
    const payoutObservedCount = payoutResults.filter(
      result => result.paid
    ).length
    const memoryFailureDetected =
      solanaMemoryErrors.length > 0 || clusterMemoryFailureCount > 0
    const diagnosis = memoryFailureDetected
      ? {
          outcome: "REPRODUCED_SOLANA_MEMORY_FAILURE",
          reason:
            "Solana epoch_in failed during RPC simulation with a program heap/out-of-memory error, so the terminal transaction was never committed and cannot appear in signature-based program-log queries.",
          result: `WIRE remained at epoch ${observedEpoch}; ${confirmed.length}/${input.expectedRequestCount} requests confirmed and ${payoutObservedCount}/${input.expectedRequestCount} destination payouts completed.`
        }
      : epochPollError !== undefined
        ? {
            outcome: "EPOCH_STALL_WITHOUT_MEMORY_EVIDENCE",
            reason:
              "WIRE stopped advancing, but neither committed Solana transactions nor aggregate cluster logs contained a memory/heap failure.",
            result: `WIRE remained at epoch ${observedEpoch}; ${confirmed.length}/${input.expectedRequestCount} requests confirmed and ${payoutObservedCount}/${input.expectedRequestCount} destination payouts completed.`
          }
        : {
            outcome: "HEALTHY_SWAP_STRESS_COMPLETION",
            reason:
              "No Solana memory/heap failure was observed and the required post-load epoch soak completed.",
            result: `WIRE reached epoch ${observedEpoch}; ${confirmed.length}/${input.expectedRequestCount} requests confirmed and ${payoutObservedCount}/${input.expectedRequestCount} destination payouts completed.`
          }

    Report.StepExtraRecorder.note("post-load terminal diagnostics", {
      diagnosis,
      baselineEpoch,
      observedEpoch,
      requiredEpoch,
      epochObservationCount: epochObservations.length,
      epochObservations,
      expectedRequestCount: input.expectedRequestCount,
      observedRequestCount: requests.length,
      confirmedRequestCount: confirmed.length,
      requestIds: requests.map(request => Number(request.id)),
      requestStatuses: requests.map(request => String(request.status)),
      payoutObservedCount,
      payoutResults,
      epochPollError:
        epochPollError instanceof Error
          ? epochPollError.message
          : String(epochPollError ?? ""),
      solanaMemoryErrors,
      solanaProgramLogReadError:
        programLogReadError instanceof Error
          ? programLogReadError.message
          : String(programLogReadError ?? ""),
      clusterLogFiles,
      clusterMemoryFailureCount,
      firstClusterMemoryFailure,
      lastClusterMemoryFailure,
      clusterMemoryFailureSamples,
      clusterLogReadError:
        clusterLogReadError instanceof Error
          ? clusterLogReadError.message
          : String(clusterLogReadError ?? "")
    })

    Assert.strictEqual(
      memoryFailureDetected,
      false,
      `${diagnosis.outcome}: ${diagnosis.reason} ${diagnosis.result}`
    )
    Assert.strictEqual(
      epochPollError,
      undefined,
      `WIRE epoch stalled at ${observedEpoch} before required epoch ${requiredEpoch}`
    )
    Assert.strictEqual(
      requests.length,
      input.expectedRequestCount,
      "unexpected number of new ETH→SOL underwrite requests"
    )
    Assert.strictEqual(
      confirmed.length,
      input.expectedRequestCount,
      "not every stress underwrite request reached CONFIRMED"
    )
    Assert.strictEqual(
      payoutObservedCount,
      input.expectedRequestCount,
      "not every stress swap completed its destination payout"
    )
    Assert.strictEqual(
      programLogReadError,
      undefined,
      "failed to read recent Solana outpost program logs"
    )
    Assert.strictEqual(
      clusterLogReadError,
      undefined,
      "failed to read aggregate cluster logs"
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
