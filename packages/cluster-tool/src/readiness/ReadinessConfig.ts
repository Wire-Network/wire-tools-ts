import Assert from "node:assert"

import type { OrchestrationConfig } from "../orchestration/OrchestrationContext.js"

/** Explicit endpoints consumed by a read-only readiness run. */
export interface ReadinessEndpoints {
  /** WIRE chain API endpoint. */
  wireRpc: string
  /** Ethereum JSON-RPC endpoint. */
  ethereumRpc: string
  /** Solana JSON-RPC endpoint. */
  solanaRpc: string
  /** Optional Hyperion base URL. */
  hyperionUrl?: string
}

/** Caller-facing options for one readiness run. */
export interface ReadinessOptions extends ReadinessEndpoints {
  /** Expected WIRE chain id; required by the connected CLI. */
  expectedWireChainId?: string
  /** Optional expected Ethereum chain id. */
  expectedEthereumChainId?: number
  /** Optional expected Solana genesis hash. */
  expectedSolanaGenesisHash?: string
  /** Maximum chain-advancement observation window. */
  observationMs?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Report output configuration used by the orchestration engine. */
  report: OrchestrationConfig["report"]
}

/** Resolved configuration for one read-only readiness build. */
export interface ReadinessConfig extends OrchestrationConfig {
  endpoints: ReadinessEndpoints
  expectedWireChainId?: string
  expectedEthereumChainId?: number
  expectedSolanaGenesisHash?: string
  observationMs: number
  timeoutMs: number
  report: OrchestrationConfig["report"]
}

/** Validate and resolve a readiness configuration without network discovery. */
export function createReadinessConfig(
  options: ReadinessOptions
): ReadinessConfig {
  const endpoints: ReadinessEndpoints = {
    wireRpc: assertHttpUrl(options.wireRpc, "wireRpc"),
    ethereumRpc: assertHttpUrl(options.ethereumRpc, "ethereumRpc"),
    solanaRpc: assertHttpUrl(options.solanaRpc, "solanaRpc"),
    ...(options.hyperionUrl
      ? { hyperionUrl: assertHttpUrl(options.hyperionUrl, "hyperionUrl") }
      : {})
  }
  if (options.expectedWireChainId != null) {
    Assert.match(
      options.expectedWireChainId,
      ReadinessConfig.WireChainIdPattern,
      "expectedWireChainId must be a 64-character hexadecimal chain id"
    )
  }
  if (options.expectedEthereumChainId != null) {
    Assert.ok(
      Number.isSafeInteger(options.expectedEthereumChainId) &&
        options.expectedEthereumChainId > 0,
      "expectedEthereumChainId must be a positive safe integer"
    )
  }
  const {
    observationMs = ReadinessConfig.DefaultObservationMs,
    timeoutMs = ReadinessConfig.DefaultTimeoutMs
  } = options
  Assert.ok(observationMs > 0, "observationMs must be positive")
  Assert.ok(timeoutMs > 0, "timeoutMs must be positive")
  return {
    endpoints,
    expectedWireChainId: options.expectedWireChainId?.toLowerCase(),
    expectedEthereumChainId: options.expectedEthereumChainId,
    expectedSolanaGenesisHash: options.expectedSolanaGenesisHash,
    observationMs,
    timeoutMs,
    report: options.report
  }
}

function assertHttpUrl(value: string, name: string): string {
  const url = new URL(value)
  Assert.ok(
    url.protocol === "http:" || url.protocol === "https:",
    `${name} must use http or https`
  )
  return url.toString().replace(/\/$/, "")
}

/** Runtime constants for connected readiness. */
export namespace ReadinessConfig {
  /** Default head-observation window. */
  export const DefaultObservationMs = 15_000
  /** Poll cadence inside the bounded head-advancement window. */
  export const AdvancementPollIntervalMs = 1_000
  /** Default individual request timeout. */
  export const DefaultTimeoutMs = 8_000
  /** Maximum acceptable WIRE head age. */
  export const FreshWireHeadLimitMs = 60_000
  /** Probe one-thousandth of a reserve's source depth. */
  export const QuoteProbeDepthDivisor = 1_000n
  /** Exact WIRE chain-id shape. */
  export const WireChainIdPattern = /^[0-9a-f]{64}$/i
}
