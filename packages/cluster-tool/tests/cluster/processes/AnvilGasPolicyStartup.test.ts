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
   * `findAvailable` takes the host-global bind-registry lock, whose retry
   * budget is bounded (~3s). Claiming inside each test spread three lock
   * acquisitions across ~21s of real anvil startup, so under a loaded parallel
   * run one of them exhausted the budget and the suite failed with "Lock file
   * is already being held" — roughly 1 run in 25. Claiming all three here
   * collapses that window to a few consecutive milliseconds.
   */
  const ports = new Map<EthereumGasPolicy, number>()

  beforeAll(async () => {
    for (const policy of [
      EthereumGasPolicy.chainDefault,
      EthereumGasPolicy.osaka,
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

  it("starts under chainDefault with the stock block limit", async () => {
    expect(await blockGasLimitFor(EthereumGasPolicy.chainDefault)).toBe(
      30_000_000
    )
  })

  it("starts under osaka", async () => {
    // The per-tx cap does not change the BLOCK limit, so the stock limit
    // stands — what matters here is that anvil accepts the flag combination.
    expect(
      await blockGasLimitFor(EthereumGasPolicy.osaka)
    ).toBeGreaterThan(0)
  })

  it("starts under uncapped with a block limit above the ETH-241 worst case", async () => {
    const limit = await blockGasLimitFor(EthereumGasPolicy.uncapped)
    expect(limit).toBe(Number(AnvilProcess.UncappedBlockGasLimit))
    expect(limit).toBeGreaterThan(93_600_000)
  })
})
