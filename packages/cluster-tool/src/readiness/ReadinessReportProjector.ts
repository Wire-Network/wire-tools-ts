import Assert from "node:assert"

import {
  ClusterFeatureReadinessState,
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature,
  type ClusterReadinessReport,
  ClusterReadinessReportSchemaCodec
} from "@wireio/cluster-tool-shared"

import type { Report } from "../report/Report.js"
import { ReadinessConfig } from "./ReadinessConfig.js"
import type { ReadinessContext } from "./ReadinessContext.js"
import { ReadinessOutputs } from "./ReadinessOutputs.js"

const RequiredClusterChecks = [
  ClusterReadinessCheckId["discovery.required-endpoints"],
  ClusterReadinessCheckId["wire.identity"],
  ClusterReadinessCheckId["wire.head-advancement"],
  ClusterReadinessCheckId["wire.head-freshness"],
  ClusterReadinessCheckId["ethereum.identity"],
  ClusterReadinessCheckId["ethereum.head-advancement"],
  ClusterReadinessCheckId["solana.identity"],
  ClusterReadinessCheckId["solana.slot-advancement"]
]

const StrictDeploymentChecks = [
  ClusterReadinessCheckId["wire.deployment-profile"],
  ClusterReadinessCheckId["ethereum.deployment-profile"],
  ClusterReadinessCheckId["solana.deployment-profile"]
]

const RequiredSwapChecks = [
  ClusterReadinessCheckId["wire.contracts"],
  ClusterReadinessCheckId["wire.epoch-scheduler"],
  ClusterReadinessCheckId["wire.chain-registry"],
  ClusterReadinessCheckId["swap.underwriting-config"],
  ClusterReadinessCheckId["swap.active-underwriters"],
  ClusterReadinessCheckId["swap.external-assets"],
  ClusterReadinessCheckId["swap.asset-registry"],
  ClusterReadinessCheckId["swap.public-reserves"],
  ClusterReadinessCheckId["swap.route-registry"],
  ClusterReadinessCheckId["swap.route-quotes"],
  ClusterReadinessCheckId["swap.request-backlog"]
]

interface RequiredCheckResult {
  id: ClusterReadinessCheckId
  status: ClusterReadinessCheckStatus
}

/** Project one orchestration run into the stable operator-facing JSON contract. */
export function projectReadinessReport(
  context: ReadinessContext,
  _orchestrationReport: Report,
  startedAt: Date,
  completedAt: Date = new Date()
): ClusterReadinessReport {
  const checkOrder = Object.values(ClusterReadinessCheckId),
    checks = [...context.outputs.assert(ReadinessOutputs.checks)].sort(
      (left, right) =>
        checkOrder.indexOf(left.id) - checkOrder.indexOf(right.id)
    ),
    feature = context.config.feature,
    strictDeployment = context.config.outpostDeploymentProfile != null,
    clusterChecks = strictDeployment
      ? [...RequiredClusterChecks, ...StrictDeploymentChecks]
      : RequiredClusterChecks,
    clusterLive = requiredChecksPassed(checks, clusterChecks),
    baseFeatureChecks =
      feature === ClusterReadinessFeature.swap
        ? RequiredSwapChecks
        : [ClusterReadinessCheckId["stake.lifecycle"]],
    featureChecks =
      feature === ClusterReadinessFeature.swap && strictDeployment
        ? [
            ...baseFeatureChecks,
            ClusterReadinessCheckId["swap.external-custody"]
          ]
        : baseFeatureChecks,
    featurePreflightReady =
      clusterLive && requiredChecksPassed(checks, featureChecks),
    featureState = featurePreflightReady
      ? ClusterFeatureReadinessState.unverified
      : ClusterFeatureReadinessState.blocked,
    candidate: ClusterReadinessReport = {
      schemaVersion: ReadinessConfig.ReportSchemaVersion,
      feature,
      generatedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      catalogUrl: context.config.catalogUrl,
      ...(context.config.requestedWireChainId
        ? { requestedWireChainId: context.config.requestedWireChainId }
        : {}),
      ...(context.outputs.get(ReadinessOutputs.observedWireChainId)
        ? {
            observedWireChainId: context.outputs.assert(
              ReadinessOutputs.observedWireChainId
            )
          }
        : {}),
      endpoints: context.config.endpoints,
      checks,
      routes: context.outputs.assert(ReadinessOutputs.routes),
      summary: {
        feature,
        clusterLive,
        featurePreflightReady,
        featureReady: false,
        featureState,
        swapPreflightReady:
          feature === ClusterReadinessFeature.swap && featurePreflightReady,
        swapReady: false,
        swapState:
          feature === ClusterReadinessFeature.swap
            ? featureState
            : ClusterFeatureReadinessState.notRun,
        stakeReady: false,
        stakeState:
          feature === ClusterReadinessFeature.stake
            ? featureState
            : ClusterFeatureReadinessState.notRun
      }
    }

  Assert.equal(
    _orchestrationReport.succeeded,
    !checks.some(
      check =>
        check.blocking && check.status === ClusterReadinessCheckStatus.fail
    ),
    "Readiness checks and orchestration Report disagree on the blocking verdict"
  )

  return ClusterReadinessReportSchemaCodec.deserialize(
    ClusterReadinessReportSchemaCodec.serialize(candidate)
  )
}

function requiredChecksPassed(
  checks: ReadonlyArray<RequiredCheckResult>,
  required: ClusterReadinessCheckId[]
): boolean {
  return required.every(id =>
    checks.some(
      check =>
        check.id === id && check.status === ClusterReadinessCheckStatus.pass
    )
  )
}
