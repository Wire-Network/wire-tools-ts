import { outputKey } from "../orchestration/OutputStore.js"

/** One collateral bucket and the active underwriters able to serve it. */
export interface ReadinessCollateralBucket {
  chainCode: number
  tokenCode: number
  label: string
  minimum: string
  accounts: string[]
  ready: boolean
  issues: string[]
}

/** Read-only preflight evidence for one directional public route. */
export interface ReadinessRoute {
  source: string
  destination: string
  quotedSourceAmount: string
  quotedDestinationAmount: string
  preflightReady: boolean
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
