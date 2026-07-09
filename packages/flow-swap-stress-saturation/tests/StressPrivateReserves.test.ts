import {
  StressPrivateReserveCreateParams,
  StressPrivateReserveMatchRequests,
  setupStressPrivateReserves
} from "@wireio/test-flow-swap-stress-saturation"

describe("setupStressPrivateReserves", () => {
  it("runs the real create/match/ACTIVE handshake in protocol order", async () => {
    // Given: protocol closures mirroring the real private-reserve flow helpers.
    const events: string[] = []

    // When: the stress private reserve setup is executed.
    const result = await setupStressPrivateReserves({
      createEthereumPrivateReserve: () =>
        record(events, "create-ethereum-private"),
      createSolanaPrivateReserve: () => record(events, "create-solana-private"),
      waitForDepotPrivateRowsPending: () =>
        record(events, "depot-private-rows-pending"),
      pushMatchReserve: async request => {
        events.push(`match-${request.side}`)
      },
      ethereumPrivateReserveActive: () =>
        recordPredicate(events, "eth-local-active", true),
      solanaPrivateReserveActive: () =>
        recordPredicate(events, "sol-local-active", true),
      readActiveSnapshot: readStressSnapshot,
      activePoll: { maxAttempts: 3, intervalMs: 0 }
    })

    // Then: both outpost creates happen before depot matching and ACTIVE waits.
    expect(events).toEqual([
      "create-ethereum-private",
      "create-solana-private",
      "depot-private-rows-pending",
      "match-ethereum",
      "match-solana",
      "eth-local-active",
      "sol-local-active"
    ])
    expect(result.stages).toEqual([
      "createEthereumPrivateReserve",
      "createSolanaPrivateReserve",
      "depotPrivateRowsPending",
      "pushMatchReserve:ethereum",
      "pushMatchReserve:solana",
      "outpostLocalPrivateRecordsActive"
    ])
    expect(result.snapshot.ethereumDepotWireAmount).toBe(
      StressPrivateReserveCreateParams.EthereumRequestedWire
    )
  })

  it("passes the ETH and SOL matchreserve requests with scaled WIRE amounts", async () => {
    // Given: a protocol surface that captures the depot matchreserve requests.
    const requests: string[] = []

    // When: the private-reserve setup reaches the depot match phase.
    await setupStressPrivateReserves({
      createEthereumPrivateReserve: () => Promise.resolve(),
      createSolanaPrivateReserve: () => Promise.resolve(),
      waitForDepotPrivateRowsPending: () => Promise.resolve(),
      pushMatchReserve: async request => {
        requests.push(`${request.side}:${request.wireAmount}`)
      },
      ethereumPrivateReserveActive: async () => true,
      solanaPrivateReserveActive: async () => true,
      readActiveSnapshot: readStressSnapshot,
      activePoll: { maxAttempts: 1, intervalMs: 0 }
    })

    // Then: ETH is matched before SOL using exported scaled reserve constants.
    expect(requests).toEqual([
      `ethereum:${StressPrivateReserveMatchRequests.Ethereum.wireAmount}`,
      `solana:${StressPrivateReserveMatchRequests.Solana.wireAmount}`
    ])
  })

  it("fails when outpost-local ACTIVE predicates never both become true", async () => {
    // Given: the SOL outpost predicate keeps reporting non-ACTIVE.
    const events: string[] = []

    // When/Then: setup fails at the ACTIVE wait instead of returning a snapshot.
    await expect(
      setupStressPrivateReserves({
        createEthereumPrivateReserve: () =>
          record(events, "create-ethereum-private"),
        createSolanaPrivateReserve: () =>
          record(events, "create-solana-private"),
        waitForDepotPrivateRowsPending: () =>
          record(events, "depot-private-rows-pending"),
        pushMatchReserve: async request => {
          events.push(`match-${request.side}`)
        },
        ethereumPrivateReserveActive: () =>
          recordPredicate(events, "eth-local-active", true),
        solanaPrivateReserveActive: () =>
          recordPredicate(events, "sol-local-active", false),
        readActiveSnapshot: readStressSnapshot,
        activePoll: { maxAttempts: 2, intervalMs: 0 }
      })
    ).rejects.toThrow("outpost-local private records ACTIVE")

    expect(events).toEqual([
      "create-ethereum-private",
      "create-solana-private",
      "depot-private-rows-pending",
      "match-ethereum",
      "match-solana",
      "eth-local-active",
      "sol-local-active",
      "eth-local-active",
      "sol-local-active"
    ])
  })

  it("documents scaled reserve values larger than the private-reserve flow", () => {
    // Given: stress setup must fund many ramp iterations, not the small e2e pair.

    // When/Then: the documented stress constants are scaled in depot frame.
    expect(StressPrivateReserveCreateParams.EthereumRequestedWire).toBe(
      1_000_000_000_000n
    )
    expect(StressPrivateReserveCreateParams.SolanaRequestedWire).toBe(
      1_000_000_000_000n
    )
    expect(StressPrivateReserveCreateParams.EthereumEscrowDepotUnits).toBe(
      StressPrivateReserveCreateParams.EthereumRequestedWire
    )
    expect(StressPrivateReserveCreateParams.SolanaEscrowDepotUnits).toBe(
      1_000_000_000n
    )
    expect(StressPrivateReserveMatchRequests.Ethereum.wireAmount).toBe(
      StressPrivateReserveCreateParams.EthereumRequestedWire
    )
    expect(StressPrivateReserveMatchRequests.Solana.wireAmount).toBe(
      StressPrivateReserveCreateParams.SolanaRequestedWire
    )
  })
})

async function record(calls: string[], label: string): Promise<void> {
  calls.push(label)
}

async function recordPredicate(
  calls: string[],
  label: string,
  active: boolean
): Promise<boolean> {
  calls.push(label)
  return active
}

async function readStressSnapshot() {
  return {
    ethereumDepotChainAmount:
      StressPrivateReserveCreateParams.EthereumEscrowDepotUnits,
    ethereumDepotWireAmount:
      StressPrivateReserveCreateParams.EthereumRequestedWire,
    solanaDepotChainAmount:
      StressPrivateReserveCreateParams.SolanaEscrowDepotUnits,
    solanaDepotWireAmount: StressPrivateReserveCreateParams.SolanaRequestedWire
  }
}
