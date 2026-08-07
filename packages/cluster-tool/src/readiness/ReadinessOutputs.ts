import type {
  ClusterReadinessCheck,
  ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"

import { outputKey } from "../orchestration/OutputStore.js"

/** One advertised collateral bucket and the ACTIVE underwriters able to serve it. */
export interface ReadinessCollateralBucket {
  /** Numeric external-chain slug. */
  chainCode: number
  /** Numeric external-token slug. */
  tokenCode: number
  /** Human-readable chain/token pair. */
  label: string
  /** Configured minimum available collateral. */
  minimum: string
  /** ACTIVE underwriters whose spendable balance meets the minimum. */
  accounts: string[]
  /** Whether the bucket has a positive requirement and a qualifying underwriter. */
  ready: boolean
  /** Exact failed invariants for this bucket. */
  issues: string[]
}

/** One advertised reserve's external custody configuration and funding state. */
export interface ReadinessExternalCustodyReserve {
  /** Numeric external-chain slug. */
  chainCode: number
  /** Numeric external-token slug. */
  tokenCode: number
  /** Numeric reserve discriminator slug. */
  reserveCode: number
  /** Human-readable chain/token/reserve triple. */
  label: string
  /** Whether token mapping, precision, and local reserve state agree. */
  configured: boolean
  /** Whether custody balance and the local reserve amount are both positive. */
  funded: boolean
  /** Whether both configuration and funding are ready. */
  ready: boolean
  /** Exact failed invariants for this reserve. */
  issues: string[]
  /** External custody balance in chain-native base units. */
  balance: string
}

/** Typed outputs accumulated by readiness Steps. */
export namespace ReadinessOutputs {
  /** Observed Wire chain id. */
  export const observedWireChainId = outputKey<string>(
    "readiness.observedWireChainId",
    "Wire chain id observed from the selected endpoint"
  )
  /** Check results in execution order. */
  export const checks = outputKey<ClusterReadinessCheck[]>(
    "readiness.checks",
    "readiness check results"
  )
  /** Public directional route evidence. */
  export const routes = outputKey<ClusterSwapRouteReadiness[]>(
    "readiness.routes",
    "public directional swap route evidence"
  )
  /** Route collateral buckets derived from the live public reserve surface. */
  export const collateralBuckets = outputKey<ReadinessCollateralBucket[]>(
    "readiness.collateralBuckets",
    "advertised collateral bucket readiness"
  )
  /** External custody state for each advertised public reserve. */
  export const externalCustodyReserves = outputKey<
    ReadinessExternalCustodyReserve[]
  >(
    "readiness.externalCustodyReserves",
    "advertised external reserve custody readiness"
  )
}
