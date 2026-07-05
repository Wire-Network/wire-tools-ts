/**
 * Network helpers — loopback / bind-all constants and `<address>:<port>` /
 * URL construction. Single source of truth for every host literal the harness
 * hands to a process, chain client, or readiness probe (folds the former
 * `tools/NetTools.ts`).
 */

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
