/** Scaled create_reserve parameters for the stress private pair. */
export namespace StressPrivateReserveCreateParams {
  /** ETH escrow: 1,000 ETH in wei; Ethereum outpost downscales 18 -> 9 dp. */
  export const EthereumEscrowWei = 1_000_000_000_000_000_000_000n
  /** Depot-frame ETH reserve seed after the outpost precision conversion. */
  export const EthereumEscrowDepotUnits = EthereumEscrowWei / 10n ** 9n
  /** WIRE matched by the owner for ETH/PRIVATE; sized for stress ramp bursts. */
  export const EthereumRequestedWire = 1_000_000_000_000n
  /** USDCSOL escrow in 6-decimal SPL base units; native precision is retained. */
  export const SolanaEscrowChainUnits = 1_000_000_000n
  /** Depot-frame USDCSOL reserve seed after Solana outpost conversion. */
  export const SolanaEscrowDepotUnits = SolanaEscrowChainUnits
  /** WIRE matched by the owner for USDCSOL/PRIVATE; sized for stress ramp bursts. */
  export const SolanaRequestedWire = 1_000_000_000_000n
  /** 50% Bancor connector weight keeps the private pair at constant product. */
  export const ConnectorWeightBps = 5000
}

/** Private reserve side used to select the chain/token/reserve triple in callers. */
export type StressPrivateReserveSide = "ethereum" | "solana"

/** Input passed to the real `sysio.reserv::matchreserve` push closure. */
export type StressPrivateReserveMatchRequest = {
  /** Private reserve row to match. */
  readonly side: StressPrivateReserveSide
  /** WIRE amount escrowed by the shared owner for this private reserve. */
  readonly wireAmount: bigint
}

/** Scaled matchreserve requests for the stress private pair. */
export namespace StressPrivateReserveMatchRequests {
  /** ETH/PRIVATE matchreserve request; caller supplies ETH chain/token/reserve codes. */
  export const Ethereum: StressPrivateReserveMatchRequest = {
    side: "ethereum",
    wireAmount: StressPrivateReserveCreateParams.EthereumRequestedWire
  }
  /** USDCSOL/PRIVATE matchreserve request; caller supplies SOL chain/token/reserve codes. */
  export const Solana: StressPrivateReserveMatchRequest = {
    side: "solana",
    wireAmount: StressPrivateReserveCreateParams.SolanaRequestedWire
  }
}

/** ACTIVE reserve amounts observed after the real create/match/ready handshake. */
export type StressPrivateReserveSnapshot = {
  /** ETH-side depot-frame chain amount. */
  readonly ethereumDepotChainAmount: bigint
  /** ETH-side matched WIRE amount. */
  readonly ethereumDepotWireAmount: bigint
  /** SOL-side depot-frame chain amount. */
  readonly solanaDepotChainAmount: bigint
  /** SOL-side matched WIRE amount. */
  readonly solanaDepotWireAmount: bigint
}

/** Real flow operations required for stress private-reserve setup. */
export type StressPrivateReserveOrchestration = {
  /** Submit ReserveManager.create_reserve for ETH/PRIVATE with native ETH escrow. */
  readonly createEthereumPrivateReserve: (
    params: typeof StressPrivateReserveCreateParams
  ) => Promise<void>
  /** Submit opp-outpost createReserve for USDCSOL/PRIVATE with SPL escrow. */
  readonly createSolanaPrivateReserve: (
    params: typeof StressPrivateReserveCreateParams
  ) => Promise<void>
  /** Wait until both depot private rows created by RESERVE_CREATE are PENDING. */
  readonly waitForDepotPrivateRowsPending: () => Promise<void>
  /** Push sysio.reserv::matchreserve for one private reserve row as the shared owner. */
  readonly pushMatchReserve: (
    request: StressPrivateReserveMatchRequest
  ) => Promise<void>
  /** Check ReserveManager.getReserve reports ETH/PRIVATE as locally ACTIVE. */
  readonly ethereumPrivateReserveActive: () => Promise<boolean>
  /** Check the Solana Reserve PDA status reports USDCSOL/PRIVATE as locally ACTIVE. */
  readonly solanaPrivateReserveActive: () => Promise<boolean>
  /** Read the final ACTIVE pair snapshot for evidence and assertions. */
  readonly readActiveSnapshot: () => Promise<StressPrivateReserveSnapshot>
  /** Poll bounds for the outpost-local ACTIVE predicates. */
  readonly activePoll?: StressPrivateReserveActivePoll
}

/** Poll bounds for waiting on outpost-local ACTIVE records. */
export type StressPrivateReserveActivePoll = {
  /** Maximum predicate checks before setup fails. */
  readonly maxAttempts: number
  /** Delay between failed checks. */
  readonly intervalMs: number
}

/** Result of the stress private-reserve setup helper. */
export type StressPrivateReserveSetupResult = {
  /** Ordered protocol stages completed by this setup helper. */
  readonly stages: readonly string[]
  /** ACTIVE pair amounts after RESERVE_READY reached both outposts. */
  readonly snapshot: StressPrivateReserveSnapshot
}

/** Error thrown when outpost-local private reserve records do not become ACTIVE. */
export class StressPrivateReserveActivationTimeoutError extends Error {
  /** Number of ACTIVE predicate attempts completed. */
  readonly attempts: number

  /**
   * Create a typed ACTIVE timeout error.
   *
   * @param attempts Number of predicate checks completed.
   */
  constructor(attempts: number) {
    super(
      `${StressPrivateReserveStageLabels.OutpostActive} after ${attempts} attempts`
    )
    this.name = "StressPrivateReserveActivationTimeoutError"
    this.attempts = attempts
  }
}

/**
 * Execute the real private-reserve create/match/ACTIVE handshake sequence.
 *
 * @param protocol Chain-specific operations that submit real outpost/depot actions.
 * @returns Ordered stage labels plus the ACTIVE reserve snapshot.
 */
export async function setupStressPrivateReserves(
  flow: StressPrivateReserveOrchestration
): Promise<StressPrivateReserveSetupResult> {
  await flow.createEthereumPrivateReserve(StressPrivateReserveCreateParams)
  await flow.createSolanaPrivateReserve(StressPrivateReserveCreateParams)
  await flow.waitForDepotPrivateRowsPending()
  await flow.pushMatchReserve(StressPrivateReserveMatchRequests.Ethereum)
  await flow.pushMatchReserve(StressPrivateReserveMatchRequests.Solana)
  await waitForOutpostLocalPrivateRecordsActive(flow)
  return {
    stages: [
      "createEthereumPrivateReserve",
      "createSolanaPrivateReserve",
      "depotPrivateRowsPending",
      "pushMatchReserve:ethereum",
      "pushMatchReserve:solana",
      "outpostLocalPrivateRecordsActive"
    ],
    snapshot: await flow.readActiveSnapshot()
  }
}

/** Labels matching the original flow's pollUntil descriptions. */
export namespace StressPrivateReserveStageLabels {
  /** Depot PENDING predicate label from the private-reserve flow. */
  export const DepotPending = "private depot rows (ETH + SOL) status=PENDING"
  /** Outpost ACTIVE predicate label from the private-reserve flow. */
  export const OutpostActive =
    "outpost-local private records ACTIVE (ETH + SOL)"
}

const DefaultActivePoll: StressPrivateReserveActivePoll = {
  maxAttempts: 120,
  intervalMs: 1_000
}

async function waitForOutpostLocalPrivateRecordsActive(
  flow: StressPrivateReserveOrchestration
): Promise<void> {
  const poll = flow.activePoll ?? DefaultActivePoll
  let attempts = 0
  while (attempts < poll.maxAttempts) {
    attempts += 1
    const [ethereumActive, solanaActive] = await Promise.all([
      flow.ethereumPrivateReserveActive(),
      flow.solanaPrivateReserveActive()
    ])
    if (ethereumActive && solanaActive) return
    if (attempts < poll.maxAttempts && poll.intervalMs > 0)
      await delay(poll.intervalMs)
  }
  throw new StressPrivateReserveActivationTimeoutError(attempts)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}
