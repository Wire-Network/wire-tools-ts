import type {
  ClusterReadinessCheck,
  ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"

import { outputKey } from "../orchestration/OutputStore.js"

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
}
