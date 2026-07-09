import { resolveLatestNonce } from "@wireio/test-cluster-tool"
import { createSwapStressPhaseRunner as createPhaseRunner } from "@wireio/test-flow-swap-stress-saturation"
import { SystemContracts } from "@wireio/sdk-core"
import { ethers } from "ethers"

import { RealRamp } from "./realFlowConstants.js"
import { batchOperatorFailureProbe } from "./realBatchOperatorFailures.js"
import {
  ethereumPayoutObserver,
  wirePayoutObserver
} from "./realFlowPayoutObservers.js"
import {
  collectPhaseMetrics,
  readReservePairSnapshot,
  routeCodes
} from "./realFlowUtils.js"
import type { RealStressFlow } from "./realFlowTypes.js"
import type {
  EthereumBurstReserveManager,
  Phase2SwapRequest,
  SolanaBurstRequest,
  StressRampIterationInput
} from "@wireio/test-flow-swap-stress-saturation"

/** Run one real stress iteration through the dependency-injected phase runner. */
export async function runRealIteration(
  flow: RealStressFlow,
  input: StressRampIterationInput
) {
  const runner = createPhaseRunner({
    route: routeCodes(),
    readReservePairSnapshot: () => readReservePairSnapshot(flow.context),
    ethereumReserveManager: ethereumBurstReserveManager(flow.reserveManager),
    getEthereumFirstNonce: count =>
      resolveLatestNonce(flow.reserveManager, count),
    submitPhase2Swap: request => submitPhase2Swap(flow, request),
    recipientPayoutObserver: wirePayoutObserver(flow.context.wireClient),
    returnPayoutObserver: ethereumPayoutObserver(flow.context.ethProvider),
    collectEnvelopeMetrics: request =>
      collectPhaseMetrics(flow.context.clusterPath, request),
    batchOperatorFailureProbe: batchOperatorFailureProbe(
      flow.context.clusterPath
    ),
    concurrency: RealRamp.Concurrency
  })
  return {
    ...(await runner.runIteration(input.accountCount)),
    iterationIndex: input.iterationIndex
  }
}

function ethereumBurstReserveManager(
  reserveManager: ethers.Contract
): EthereumBurstReserveManager {
  return {
    requestSwap: (
      sourceTokenCode,
      sourceReserveCode,
      targetChainCode,
      targetTokenCode,
      targetReserveCode,
      targetRecipient,
      targetAmount,
      targetToleranceBps,
      overrides
    ) =>
      reserveManager.requestSwap(
        sourceTokenCode,
        sourceReserveCode,
        targetChainCode,
        targetTokenCode,
        targetReserveCode,
        targetRecipient,
        targetAmount,
        targetToleranceBps,
        overrides
      )
  }
}

async function submitPhase2Swap(
  flow: RealStressFlow,
  request: SolanaBurstRequest<Phase2SwapRequest>
): Promise<string> {
  const result =
    await flow.context.wireClient.clio.pushActionAndWait<SystemContracts.SysioUwritSwapfromwireAction>(
      "sysio.uwrit",
      "swapfromwire",
      {
        user: request.request.sourceAccount,
        wire_amount: Number(request.request.sourceAmount),
        dst_chain_code: { value: Number(request.request.targetChainCode) },
        dst_token_code: { value: Number(request.request.targetTokenCode) },
        dst_reserve_code: { value: Number(request.request.targetReserveCode) },
        target_amount: Number(request.request.targetAmount),
        target_tolerance_bps: request.request.targetToleranceBps,
        recipient_kind: SystemContracts.SysioUwritChainkind.CHAIN_KIND_EVM,
        recipient_addr: Buffer.from(request.request.targetRecipient).toString(
          "hex"
        )
      },
      `${request.request.sourceAccount}@active`
    )
  return result.transaction_id ?? `wire-swapfromwire-${request.index}`
}
