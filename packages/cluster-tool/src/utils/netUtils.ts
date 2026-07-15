/**
 * Network helpers — loopback / bind-all constants, `<address>:<port>` /
 * URL construction, and socket probes. Single source of truth for every host
 * literal the harness hands to a process, chain client, or readiness probe
 * (folds the former `tools/NetTools.ts`).
 */
import Dgram from "node:dgram"
import { Deferred, guard } from "@wireio/shared"

/**
 * Loopback IPv4 address — the default `address` for {@link toURL}/{@link toAddress}
 * and every endpoint the harness hands to a chain client / RPC provider /
 * readiness probe. `"localhost"` (DNS) is unified to this literal so client-side
 * URLs and server-side bind values share one source of truth.
 */
export const Localhost = "127.0.0.1" as const

/**
 * Bind-all address — the listen endpoint for sockets that should accept traffic
 * on every interface. Distinct from {@link Localhost}: "listen on every
 * interface" is a different concept from "connect to the loopback IP".
 */
export const ListenAllAddress = "0.0.0.0" as const

/**
 * URL schemes the harness builds. A tight union (not bare `string`) so a
 * call-site typo fails at `tsc` rather than against an unreachable URL.
 */
export type URLScheme = "http" | "https" | "ws" | "wss"

/**
 * Build an `<address>:<port>` host string — the scheme-less form nodeop / kiod /
 * anvil / solana-test-validator accept for `--p2p-server-address`,
 * `--http-server-address`, and equivalent bind / advertise options.
 *
 * @param port - Numeric port.
 * @param address - Hostname or IP. Defaults to {@link Localhost}.
 * @returns The `<address>:<port>` host string.
 * @example
 *   toAddress(8888)                   // "127.0.0.1:8888"
 *   toAddress(9876, ListenAllAddress) // "0.0.0.0:9876"
 */
export function toAddress(port: number, address: string = Localhost): string {
  return `${address}:${port}`
}

/**
 * Build a `<scheme>://<address>:<port>` URL — single source of truth for every
 * endpoint string the harness hands to chain clients, provider constructors,
 * and readiness probes. Delegates the host half to {@link toAddress}.
 *
 * @param port - Numeric port the service listens on.
 * @param address - Hostname or IP. Defaults to {@link Localhost}.
 * @param scheme - URL scheme. Defaults to `"http"`.
 * @returns The fully-qualified URL.
 * @example
 *   toURL(8888)                  // "http://127.0.0.1:8888"
 *   toURL(8899, Localhost, "ws") // "ws://127.0.0.1:8899"
 */
export function toURL(
  port: number,
  address: string = Localhost,
  scheme: URLScheme = "http"
): string {
  return `${scheme}://${toAddress(port, address)}`
}

/**
 * True when `port` accepts a UDP bind on all interfaces right now. `get-port`
 * (the TCP probe behind every BindConfig path) cannot see a UDP-only holder —
 * a foreign daemon, or another cluster's validator sockets — while that is
 * exactly what an agave validator trips over first: its gossip/TPU/TVU
 * sockets are UDP. In the 2026-07-15 e2e gate run, validators handed the
 * default port set died within milliseconds of spawn (exit 101) five times in
 * a row while every TCP probe passed — the holder was UDP-only and outside
 * the bind registry. UDP-role ports must be probed with a UDP bind.
 *
 * @param port - Port to probe.
 * @returns Whether a UDP bind on `port` succeeds.
 */
export function isUdpPortFree(port: number): Promise<boolean> {
  const result = new Deferred<boolean>()
  const probe = Dgram.createSocket("udp4")
  probe.once("error", () => {
    guard(() => probe.close())
    result.resolve(false)
  })
  probe.bind(port, () => probe.close(() => result.resolve(true)))
  return result.promise
}

/**
 * Filter `ss`/`netstat`-style socket lines down to those whose LOCAL address
 * carries one of `ports`. A local address is the 5th whitespace field of the
 * standard `ss -tuapn` row (`Netid State Recv-Q Send-Q Local:Port Peer:Port
 * [process]`); the port is whatever follows the last `:` (covers `0.0.0.0:80`,
 * `[::]:80`, and `127.0.0.1%lo:80` forms). Pure — callers run `ss` themselves.
 *
 * @param output - Raw multi-line `ss -tuapn` output.
 * @param ports - Local ports to keep.
 * @returns The matching lines, header excluded.
 */
export function filterSocketLinesByLocalPort(
  output: string,
  ports: ReadonlySet<number>
): string[] {
  return output
    .split("\n")
    .filter(line => {
      const local = line.trim().split(/\s+/)[4] ?? ""
      const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10)
      return Number.isFinite(port) && ports.has(port)
    })
}
