import type {
  ClusterConfigReport,
  ClusterReadinessEndpoint,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"

import type { OrchestrationConfig } from "../orchestration/OrchestrationContext.js"

/** Caller-facing options for a connected, read-only readiness run. */
export interface ReadinessOptions {
  /** Product surface to inspect. */
  feature?: ClusterReadinessFeature
  /** Expected 64-character Wire chain id. */
  wireChainId?: string
  /** Explicit Wire RPC override. */
  wireRpc?: string
  /** Explicit Ethereum JSON-RPC override. */
  ethereumRpc?: string
  /** Explicit Solana JSON-RPC override. */
  solanaRpc?: string
  /** Optional Hyperion base URL override. */
  hyperionUrl?: string
  /** Endpoint catalog URL override. */
  catalogUrl?: string
  /** Maximum head-advancement observation window. */
  observationMs?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Report output configuration used by the orchestration engine. */
  report: ClusterConfigReport
}

/** Resolved configuration for one readiness orchestration build. */
export interface ReadinessConfig extends OrchestrationConfig {
  feature: ClusterReadinessFeature
  catalogUrl: string
  requestedWireChainId: string | null
  endpoints: ClusterReadinessEndpoint[]
  catalogRecordCount: number
  catalogErrors: string[]
  observationMs: number
  timeoutMs: number
  report: ClusterConfigReport
}

/** Runtime constants for connected readiness. */
export namespace ReadinessConfig {
  /** Hub-compatible endpoint catalog. */
  export const DefaultCatalogUrl = "https://api.wire.foundation/rpc-endpoints"
  /** Default head-observation window. */
  export const DefaultObservationMs = 15_000
  /** Poll cadence inside the bounded head-advancement window. */
  export const AdvancementPollIntervalMs = 1_000
  /** Default individual request timeout. */
  export const DefaultTimeoutMs = 8_000
  /** Current operator-report contract version. */
  export const ReportSchemaVersion = 1
  /** Maximum acceptable Wire head age. */
  export const FreshWireHeadLimitMs = 60_000
  /** Probe one-thousandth of a reserve's source depth. */
  export const QuoteProbeDepthDivisor = 1_000n
  /** Exact Wire chain-id shape. */
  export const WireChainIdPattern = /^[0-9a-f]{64}$/i
}
