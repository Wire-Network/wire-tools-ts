import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"

/** Product surface selected for one readiness run. */
export enum ClusterReadinessFeature {
  swap = "swap",
  stake = "stake"
}

/** Report sections used to calculate independent readiness decisions. */
export enum ClusterReadinessArea {
  discovery = "discovery",
  cluster = "cluster",
  swap = "swap",
  stake = "stake"
}

/** Stable result states emitted for individual readiness checks. */
export enum ClusterReadinessCheckStatus {
  pass = "pass",
  fail = "fail",
  advisory = "advisory"
}

/** Stable reason codes used by the operator-facing readiness report. */
export enum ClusterReadinessReasonCode {
  "cluster-unverified" = "cluster-unverified",
  "protocol-unavailable" = "protocol-unavailable",
  "deployment-incomplete" = "deployment-incomplete",
  "configuration-incomplete" = "configuration-incomplete",
  "network-unavailable" = "network-unavailable",
  "version-incompatible" = "version-incompatible",
  "asset-unavailable" = "asset-unavailable",
  "liquidity-unavailable" = "liquidity-unavailable"
}

/** Stable identifiers for the manual readiness assertions. */
export enum ClusterReadinessCheckId {
  "discovery.endpoint-catalog" = "discovery.endpoint-catalog",
  "discovery.required-endpoints" = "discovery.required-endpoints",
  "wire.identity" = "wire.identity",
  "wire.head-advancement" = "wire.head-advancement",
  "wire.head-freshness" = "wire.head-freshness",
  "wire.deployment-profile" = "wire.deployment-profile",
  "ethereum.identity" = "ethereum.identity",
  "ethereum.head-advancement" = "ethereum.head-advancement",
  "ethereum.deployment-profile" = "ethereum.deployment-profile",
  "solana.identity" = "solana.identity",
  "solana.slot-advancement" = "solana.slot-advancement",
  "solana.deployment-profile" = "solana.deployment-profile",
  "hyperion.health" = "hyperion.health",
  "wire.contracts" = "wire.contracts",
  "wire.epoch-scheduler" = "wire.epoch-scheduler",
  "wire.chain-registry" = "wire.chain-registry",
  "swap.underwriting-config" = "swap.underwriting-config",
  "swap.active-underwriters" = "swap.active-underwriters",
  "swap.external-assets" = "swap.external-assets",
  "swap.asset-registry" = "swap.asset-registry",
  "swap.public-reserves" = "swap.public-reserves",
  "swap.route-registry" = "swap.route-registry",
  "swap.route-quotes" = "swap.route-quotes",
  "swap.request-backlog" = "swap.request-backlog",
  "stake.lifecycle" = "stake.lifecycle"
}

/** Endpoint roles understood by readiness. */
export enum ClusterReadinessEndpointKind {
  wire = "wire",
  hyperion = "hyperion",
  ethereum = "ethereum",
  solana = "solana"
}

/** Where a selected endpoint was obtained. */
export enum ClusterReadinessEndpointSource {
  catalog = "catalog",
  explicit = "explicit"
}

/** Full feature state, which remains unverified until a transaction settles. */
export enum ClusterFeatureReadinessState {
  ready = "ready",
  blocked = "blocked",
  unverified = "unverified",
  notRun = "notRun"
}

/** One selected RPC or API endpoint. */
export const ClusterReadinessEndpointSchema = z.object({
  kind: z.enum(ClusterReadinessEndpointKind),
  url: z.string(),
  source: z.enum(ClusterReadinessEndpointSource),
  name: z.string().optional(),
  expectedChainId: z.string().optional(),
  chainCode: z.string().optional()
})
/** One selected RPC or API endpoint. */
export type ClusterReadinessEndpoint = z.infer<
  typeof ClusterReadinessEndpointSchema
>

/** One machine-readable readiness assertion. */
export const ClusterReadinessCheckSchema = z.object({
  id: z.enum(ClusterReadinessCheckId),
  area: z.enum(ClusterReadinessArea),
  status: z.enum(ClusterReadinessCheckStatus),
  blocking: z.boolean(),
  reason: z.enum(ClusterReadinessReasonCode).optional(),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()).optional()
})
/** One machine-readable readiness assertion. */
export type ClusterReadinessCheck = z.infer<typeof ClusterReadinessCheckSchema>

/** Read-only route evidence for one public swap direction. */
export const ClusterSwapRouteReadinessSchema = z.object({
  source: z.string(),
  destination: z.string(),
  preflightReady: z.boolean(),
  quotedSourceAmount: z.string(),
  quotedDestinationAmount: z.string(),
  transactionallyVerified: z.boolean(),
  detail: z.string()
})
/** Read-only route evidence for one public swap direction. */
export type ClusterSwapRouteReadiness = z.infer<
  typeof ClusterSwapRouteReadinessSchema
>

/** Independent readiness decisions derived from one run. */
export const ClusterReadinessSummarySchema = z.object({
  feature: z.enum(ClusterReadinessFeature),
  clusterLive: z.boolean(),
  featurePreflightReady: z.boolean(),
  featureReady: z.boolean(),
  featureState: z.enum(ClusterFeatureReadinessState),
  swapPreflightReady: z.boolean(),
  swapReady: z.boolean(),
  swapState: z.enum(ClusterFeatureReadinessState),
  stakeReady: z.boolean(),
  stakeState: z.enum(ClusterFeatureReadinessState)
})
/** Independent readiness decisions derived from one run. */
export type ClusterReadinessSummary = z.infer<
  typeof ClusterReadinessSummarySchema
>

/** Schema-versioned operator artifact emitted by a manual readiness run. */
export const ClusterReadinessReportSchema = z.object({
  schemaVersion: z.number().int().positive(),
  feature: z.enum(ClusterReadinessFeature),
  generatedAt: z.string(),
  durationMs: z.number().nonnegative(),
  catalogUrl: z.string(),
  requestedWireChainId: z.string().optional(),
  observedWireChainId: z.string().optional(),
  endpoints: z.array(ClusterReadinessEndpointSchema),
  checks: z.array(ClusterReadinessCheckSchema),
  routes: z.array(ClusterSwapRouteReadinessSchema),
  summary: ClusterReadinessSummarySchema
})
/** Schema-versioned operator artifact emitted by a manual readiness run. */
export type ClusterReadinessReport = z.infer<
  typeof ClusterReadinessReportSchema
>

/** Validated codec for the readiness JSON artifact. */
export const ClusterReadinessReportSchemaCodec =
  SchemaCodec.create<ClusterReadinessReport>(ClusterReadinessReportSchema)
