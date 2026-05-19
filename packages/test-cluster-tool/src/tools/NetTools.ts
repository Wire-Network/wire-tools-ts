/**
 * Network-related helpers shared across the harness — URL construction,
 * loopback constants, and (future) other socket-layer utilities. Lives
 * under `tools/` to keep the surface together with the other reusable
 * helpers (`AuthExLinkTool`, `ETHCollateralTool`, `SOLCollateralTool`,
 * `AnchorEnumTools`, `underwriter/`).
 */

/**
 * Loopback IPv4 address. Default `address` for {@link toURL} and any
 * endpoint the harness hands to a chain client / RPC provider /
 * readiness probe, plus any place nodeop / kiod / anvil /
 * solana-test-validator needs a hostname for `--p2p-server-address` /
 * `--http-server-address` / equivalent. `"localhost"` (DNS) is treated
 * as equivalent and unified to this IP literal across the harness so
 * client-side URLs and server-side bind values come from the same
 * source of truth.
 */
export const Localhost = "127.0.0.1" as const

/**
 * Bind-all address — used as the listen endpoint for sockets that
 * should accept traffic on every interface (nodeop's
 * `--p2p-listen-endpoint`, kiod's listen address, etc.). Distinct
 * from {@link Localhost} because the bind side is genuinely a
 * different concept: "listen on every interface" vs "connect to the
 * local loopback IP".
 */
export const ListenAllAddress = "0.0.0.0" as const

/**
 * Schemes the harness builds URLs for. Tight union (not bare
 * `string`) so a call-site typo fails at `tsc` rather than against
 * an unreachable URL at runtime.
 */
export type URLScheme = "http" | "https" | "ws" | "wss"

/**
 * Build an `<address>:<port>` host string — the scheme-less form
 * nodeop / kiod / anvil / solana-test-validator accept for
 * `--p2p-server-address`, `--p2p-listen-endpoint`,
 * `--http-server-address`, and equivalent bind / advertise options.
 * Single source of truth for every host literal the harness hands
 * to a process, so changing the default loopback IP (or substituting
 * an alternate address for a specific subprocess) is one
 * compile-checked argument.
 *
 * @param port    Numeric port.
 * @param address Hostname or IP. Defaults to {@link Localhost}.
 * @example
 *   toAddress(8888)                        // → "127.0.0.1:8888"
 *   toAddress(9876, ListenAllAddress)      // → "0.0.0.0:9876"
 */
export function toAddress(
  port: number,
  address: string = Localhost
): string {
  return `${address}:${port}`
}

/**
 * Build a `<scheme>://<address>:<port>` URL. Single source of truth
 * for every endpoint string the harness hands to chain clients,
 * provider constructors, and readiness probes — replaces the
 * per-namespace `toLocalHttpUrl` helpers and the scattered inline
 * `http://127.0.0.1:${port}` literals. Delegates the address half
 * to {@link toAddress} so URL- and host-form construction share a
 * single implementation.
 *
 * @param port    Numeric port the service is listening on.
 * @param address Hostname or IP. Defaults to {@link Localhost}.
 * @param scheme  URL scheme. Defaults to `"http"`.
 * @example
 *   toURL(8888)                                // → "http://127.0.0.1:8888"
 *   toURL(8899, Localhost, "ws")               // → "ws://127.0.0.1:8899"
 *   toURL(443, "explorer.wire.foundation", "https")
 */
export function toURL(
  port: number,
  address: string = Localhost,
  scheme: URLScheme = "http"
): string {
  return `${scheme}://${toAddress(port, address)}`
}
