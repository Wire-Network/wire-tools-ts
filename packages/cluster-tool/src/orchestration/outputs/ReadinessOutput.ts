import { outputKey } from "../OutputStore.js"

/** One collateral bucket and the active underwriters able to serve it. */
export interface ReadinessCollateralBucket {
  /** Numeric WIRE chain slug. */
  chainCode: number
  /** Numeric WIRE token slug. */
  tokenCode: number
  /** Human-readable chain/token label. */
  label: string
  /** Minimum required collateral in the token's base units. */
  minimum: string
  /** Active underwriter accounts able to serve this bucket. */
  accounts: string[]
  /** Whether at least one active underwriter can serve the bucket. */
  ready: boolean
  /** Reasons the bucket is not ready. */
  issues: string[]
}

/** Read-only preflight evidence for one directional public route. */
export interface ReadinessRoute {
  /** Human-readable source reserve label. */
  source: string
  /** Human-readable destination reserve label. */
  destination: string
  /** Source probe amount in base units. */
  quotedSourceAmount: string
  /** Canonical quoted destination amount in base units. */
  quotedDestinationAmount: string
  /** Whether quote and per-route collateral checks passed. */
  preflightReady: boolean
  /** Reasons the route is not preflight-ready. */
  issues: string[]
}

/** Typed cross-step values accumulated by readiness Steps. */
export namespace ReadinessOutputs {
  /** WIRE chain id observed from the selected endpoint. */
  export const observedWireChainId = outputKey<string>(
    "readiness.observedWireChainId",
    "WIRE chain id observed from the selected endpoint"
  )
  /** Ethereum chain id observed from the selected endpoint. */
  export const observedEthereumChainId = outputKey<number>(
    "readiness.observedEthereumChainId",
    "Ethereum chain id observed from the selected endpoint"
  )
  /** Solana genesis hash observed from the selected endpoint. */
  export const observedSolanaGenesisHash = outputKey<string>(
    "readiness.observedSolanaGenesisHash",
    "Solana genesis hash observed from the selected endpoint"
  )
  /** Public directional route evidence. */
  export const routes = outputKey<ReadinessRoute[]>(
    "readiness.routes",
    "public directional swap route evidence"
  )
  /** Available collateral by advertised reserve bucket. */
  export const collateralBuckets = outputKey<ReadinessCollateralBucket[]>(
    "readiness.collateralBuckets",
    "advertised collateral bucket readiness"
  )
}
