import { spawn } from "node:child_process"

import { EthereumGasPolicy } from "@wireio/cluster-tool-shared"

import { NestedError } from "@wireio/shared"

import { AnvilProcess, BindConfigProvider } from "@wireio/cluster-tool"

/** The `latest` block fields this suite reads back from anvil. */
interface LatestBlock {
  gasLimit?: string
}

/** The `eth_getBlockByNumber` envelope anvil returns. */
interface LatestBlockResponse {
  result?: LatestBlock
}

/**
 * Every gas policy must produce flags anvil ACCEPTS.
 *
 * Asserting the flag STRINGS is not enough, and this suite exists because that
 * gap shipped: `uncapped` originally emitted
 * `--gas-limit … --disable-block-gas-limit`, which anvil rejects outright
 * ("the argument '--gas-limit' cannot be used with '--disable-block-gas-limit'")
 * and exits 2. The unit test passed, the build passed, and a live run died in
 * its outpost-deploy phase.
 */
describe("anvil accepts every gas policy's flags", () => {
  const StartupGraceMs = 6_000

  /**
   * One port per policy, claimed UP FRONT.
   *
   * `findAvailable` takes the host-global bind-registry lock. Claiming inside
   * each test spread the acquisitions across many seconds of real anvil
   * startup; claiming here collapses that window to consecutive milliseconds,
   * so this suite contributes as little lock contention as possible.
   */
  const ports = new Map<EthereumGasPolicy, number>()

  beforeAll(async () => {
    for (const policy of [
      EthereumGasPolicy.mainnetParity,
      EthereumGasPolicy.uncapped
    ])
      ports.set(
        policy,
        await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
      )
  })

  /**
   * Spawn anvil with a policy's flags.
   *
   * @param policy - The policy whose flags are exercised.
   * @returns The block gas limit anvil reports, or a rejection on startup exit.
   */
  async function blockGasLimitFor(policy: EthereumGasPolicy): Promise<number> {
    const port = ports.get(policy),
      child = spawn(
        "anvil",
        ["--port", String(port), ...AnvilProcess.gasPolicyArgs(policy)],
        { stdio: ["ignore", "ignore", "pipe"] }
      )
    let stderr = ""
    child.stderr.on("data", chunk => (stderr += String(chunk)))
    try {
      const limit = await new Promise<number>((resolve, reject) => {
        child.once("exit", code =>
          reject(
            new NestedError("anvil exited before serving", {
              context: { code, stderr: stderr.trim() }
            })
          )
        )
        const deadline = Date.now() + StartupGraceMs
        const retry = (cause: unknown): void => {
          if (Date.now() <= deadline) setTimeout(poll, 200)
          else
            reject(
              new NestedError(`anvil never served on ${port}`, {
                cause,
                context: { port, stderr: stderr.trim() }
              })
            )
        }
        const poll = (): void => {
          fetch(`http://127.0.0.1:${port}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getBlockByNumber",
              params: ["latest", false]
            })
          })
            .then(async response => {
              // Not yet serving a block is ordinary startup latency, not an
              // error — retry rather than throwing for control flow.
              const body = (await response.json()) as LatestBlockResponse,
                gasLimit = body.result?.gasLimit
              if (gasLimit === undefined) retry(null)
              else resolve(Number(BigInt(gasLimit)))
            })
            .catch((error: unknown) => retry(error))
        }
        poll()
      })
      return limit
    } finally {
      child.kill("SIGKILL")
    }
  }

  it("starts under mainnetParity at the sized block limit", async () => {
    // The EIP-7825 per-tx cap does not appear in the block header, so what is
    // observable here is the block limit; that anvil ACCEPTS the flag
    // combination (pinned hardfork + --enable-tx-gas-limit + --gas-limit) is
    // the other half of the assertion, and a rejected combination exits 2.
    expect(await blockGasLimitFor(EthereumGasPolicy.mainnetParity)).toBe(
      AnvilProcess.BlockGasLimit
    )
  })

  it("starts under uncapped with a block limit above the ETH-241 worst case", async () => {
    const limit = await blockGasLimitFor(EthereumGasPolicy.uncapped)
    expect(limit).toBe(AnvilProcess.UncappedBlockGasLimit)
    // ETH-241 measured ~93.6M for a backlogged outbound envelope; the point of
    // this regime is to clear that by an order of magnitude.
    expect(limit).toBeGreaterThan(93_600_000)
  })
})
