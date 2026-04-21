// ---------------------------------------------------------------------------
// Cluster port management
// ---------------------------------------------------------------------------

import type { ClusterPorts as SharedClusterPorts } from "@wire-e2e-tests/debugging-shared"
import {
  BASE_HTTP_PORT,
  BASE_P2P_PORT,
  BIOS_HTTP_PORT,
  BIOS_P2P_PORT
} from "./constants.js"

/**
 * All ports used by a cluster. Shape lives in debugging-shared; re-declared
 * here via `extends` so the companion namespace below (port resolvers,
 * default constants) can merge with the type locally.
 */
export interface ClusterPorts extends SharedClusterPorts {}

export namespace ClusterPorts {
  export const DefaultKiod = 8900
  export const DefaultBiosHttp = BIOS_HTTP_PORT
  export const DefaultBiosP2p = BIOS_P2P_PORT
  export const DefaultProducerHttpBase = BASE_HTTP_PORT
  export const DefaultProducerP2pBase = BASE_P2P_PORT
  export const DefaultAnvil = 8545
  export const DefaultSolanaRpc = 8899
  export const DefaultSolanaFaucet = 9900
  export const DefaultDebuggingServer = 9901

  /** Check if a port is available using raw net.createServer. */
  function isPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const server = require("net").createServer()
      server.once("error", () => resolve(false))
      server.once("listening", () => {
        server.close(() => resolve(true))
      })
      server.listen(port, "127.0.0.1")
    })
  }

  /** Find an available port, starting from preferred. */
  async function getPort(options?: { port?: number[] }): Promise<number> {
    if (options?.port) {
      for (const p of options.port) {
        if (await isPortAvailable(p)) return p
      }
    }
    // Fallback: let OS assign
    return new Promise((resolve, reject) => {
      const server = require("net").createServer()
      server.once("error", reject)
      server.once("listening", () => {
        const port = server.address().port
        server.close(() => resolve(port))
      })
      server.listen(0, "127.0.0.1")
    })
  }

  /**
   * Resolve all ports for a new cluster.
   * Uses `get-port` to find available ports starting from defaults.
   */
  export async function resolve(opts: {
    nodeCount: number
    batchOperatorCount: number
    underwriterCount: number
  }): Promise<ClusterPorts> {
    const claimed = new Set<number>()

    async function claim(preferred: number): Promise<number> {
      let port = await getPort({ port: [preferred] })
      while (claimed.has(port)) {
        port = await getPort()
      }
      claimed.add(port)
      return port
    }

    async function claimRange(base: number, count: number): Promise<number[]> {
      const ports: number[] = []
      for (let i = 0; i < count; i++) {
        ports.push(await claim(base + i))
      }
      return ports
    }

    const kiod = await claim(DefaultKiod)
    const biosHttp = await claim(DefaultBiosHttp)
    const biosP2p = await claim(DefaultBiosP2p)
    const producerHttp = await claimRange(
      DefaultProducerHttpBase,
      opts.nodeCount
    )
    const producerP2p = await claimRange(DefaultProducerP2pBase, opts.nodeCount)

    const boHttpBase = DefaultProducerHttpBase + opts.nodeCount
    const boP2pBase = DefaultProducerP2pBase + opts.nodeCount
    const batchOperatorHttp = await claimRange(
      boHttpBase,
      opts.batchOperatorCount
    )
    const batchOperatorP2p = await claimRange(
      boP2pBase,
      opts.batchOperatorCount
    )

    const uwHttpBase = boHttpBase + opts.batchOperatorCount
    const uwP2pBase = boP2pBase + opts.batchOperatorCount
    const underwriterHttp = await claimRange(uwHttpBase, opts.underwriterCount)
    const underwriterP2p = await claimRange(uwP2pBase, opts.underwriterCount)

    const anvil = await claim(DefaultAnvil)
    const solanaRpc = await claim(DefaultSolanaRpc)
    const solanaFaucet = await claim(DefaultSolanaFaucet)
    const debuggingServer = await claim(DefaultDebuggingServer)

    return {
      kiod,
      biosHttp,
      biosP2p,
      producerHttp,
      producerP2p,
      batchOperatorHttp,
      batchOperatorP2p,
      underwriterHttp,
      underwriterP2p,
      anvil,
      solanaRpc,
      solanaFaucet,
      debuggingServer
    }
  }

  /**
   * Verify all ports in a saved config are currently available.
   * Throws if any port is occupied.
   */
  export async function verifyAvailable(ports: ClusterPorts): Promise<void> {
    const all = [
      ports.kiod,
      ports.biosHttp,
      ports.biosP2p,
      ...ports.producerHttp,
      ...ports.producerP2p,
      ...ports.batchOperatorHttp,
      ...ports.batchOperatorP2p,
      ...ports.underwriterHttp,
      ...ports.underwriterP2p,
      ports.anvil,
      ports.solanaRpc,
      ports.solanaFaucet,
      ports.debuggingServer
    ]

    const unavailable: number[] = []
    for (const port of all) {
      const actual = await getPort({ port: [port] })
      if (actual !== port) unavailable.push(port)
    }

    if (unavailable.length > 0) {
      throw new Error(
        `Ports unavailable: ${unavailable.join(", ")}. Kill existing processes or use --force.`
      )
    }
  }
}
