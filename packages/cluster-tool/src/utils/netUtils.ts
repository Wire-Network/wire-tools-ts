/**
 * Network helpers — loopback / bind-all constants, `<address>:<port>` /
 * URL construction, and socket probes. Single source of truth for every host
 * literal the harness hands to a process, chain client, or readiness probe
 * (folds the former `tools/NetTools.ts`).
 */
import Assert from "node:assert"
import Dgram from "node:dgram"
import Net from "node:net"
import Os from "node:os"
import { match, P } from "ts-pattern"
import { MaximumPort, MinimumPort } from "@wireio/cluster-tool-shared"
import { Deferred, getValue, guard } from "@wireio/shared"

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

/** Bind-all address, IPv6 form — the `::` wildcard (dialed at the loopback, like `0.0.0.0`). */
export const ListenAllAddressV6 = "::" as const

/** Loopback IPv6 address. */
export const LocalhostV6 = "::1" as const

/** The IPv4 loopback network, `127.0.0.0/8`. */
const LoopbackNetworkV4 = "127.0.0.0"
/** Prefix length of {@link LoopbackNetworkV4}. */
const LoopbackPrefixLengthV4 = 8
/** The address families `Net.BlockList` takes. */
enum IpFamily {
  ipv4 = "ipv4",
  ipv6 = "ipv6"
}

/** Separator of an IPv6 zone suffix (`fe80::1%eth0`). */
const Ipv6ZoneSeparator = "%"

/**
 * Addresses that are this host whatever its interfaces: the bind-all wildcards
 * and loopback. `Net.BlockList` matches every spelling of them (`::0`,
 * `0:0:0:0:0:0:0:0`, IPv4-mapped `::ffff:0.0.0.0`).
 */
const HostAddresses = new Net.BlockList()
HostAddresses.addAddress(ListenAllAddress, IpFamily.ipv4)
HostAddresses.addAddress(ListenAllAddressV6, IpFamily.ipv6)
HostAddresses.addSubnet(LoopbackNetworkV4, LoopbackPrefixLengthV4, IpFamily.ipv4)
HostAddresses.addAddress(LocalhostV6, IpFamily.ipv6)

/**
 * The address family of an IP literal, or `null` when `address` is not one.
 *
 * @param address - An address, zone suffix already removed.
 * @returns Its family, or `null`.
 */
function ipFamily(address: string): IpFamily {
  return match(address)
    .with(P.when(Net.isIPv4), () => IpFamily.ipv4)
    .with(P.when(Net.isIPv6), () => IpFamily.ipv6)
    .otherwise(() => null)
}

/**
 * Whether an IP literal is the address of one of this host's interfaces. Fails
 * closed: when the interfaces cannot be listed, the answer is `true`.
 *
 * @param literal - An IP literal without a zone suffix.
 * @param family - Its family.
 * @returns Whether an interface of this host has that address.
 */
function isInterfaceAddress(literal: string, family: IpFamily): boolean {
  return getValue(() => {
    const interfaceAddresses = new Net.BlockList()
    Object.values(Os.networkInterfaces())
      .flat()
      .filter(networkInterface => networkInterface != null)
      .forEach(({ address }) =>
        interfaceAddresses.addAddress(address, ipFamily(address))
      )
    return interfaceAddresses.check(literal, family)
  }, true)
}

/**
 * Whether a bind address may belong to THIS host. Fails closed: the answer is
 * `false` (another host's) ONLY for an IP literal that is not a bind-all
 * wildcard, not loopback, and not the address of one of this host's
 * interfaces. Every host name (`localhost`, `rpc.example`) and the empty
 * string count as local, because this host cannot tell which machine they
 * name. An IPv6 zone suffix is ignored. A remote outpost endpoint is
 * therefore recognised as remote only when it is given as an IP literal.
 *
 * @param address - A daemon's bind address.
 * @returns Whether a daemon bound to it may listen on this host.
 */
export function isLocalAddress(address: string): boolean {
  const [literal] = address.split(Ipv6ZoneSeparator),
    family = ipFamily(literal)
  return (
    family === null ||
    HostAddresses.check(literal, family) ||
    isInterfaceAddress(literal, family)
  )
}

/**
 * URL schemes the harness builds. A typed identity enum (not bare `string`)
 * so a call-site typo fails at `tsc` rather than against an unreachable URL.
 */
export enum URLScheme {
  http = "http",
  https = "https",
  ws = "ws",
  wss = "wss"
}

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
  // Bracket an IPv6 literal (`::1`, `fe80::1`) so the `:<port>` stays unambiguous.
  const host =
    address.includes(":") && !address.startsWith("[") ? `[${address}]` : address
  return `${host}:${port}`
}

/**
 * Build a `<scheme>://<address>:<port>` URL — single source of truth for every
 * endpoint string the harness hands to chain clients, provider constructors,
 * and readiness probes. Delegates the host half to {@link toAddress}.
 *
 * @param port - Numeric port the service listens on.
 * @param address - Hostname or IP. Defaults to {@link Localhost}.
 * @param scheme - URL scheme. Defaults to {@link URLScheme.http}.
 * @returns The fully-qualified URL.
 * @example
 *   toURL(8888)                            // "http://127.0.0.1:8888"
 *   toURL(8899, Localhost, URLScheme.ws)   // "ws://127.0.0.1:8899"
 */
export function toURL(
  port: number,
  address: string = Localhost,
  scheme: URLScheme = URLScheme.http
): string {
  return `${scheme}://${toAddress(port, address)}`
}

/**
 * The `<address>:<port>` shape {@link assertEndpoint} enforces: a HOST — a
 * hostname / IPv4 literal (letters, digits, `.`, `_`, `-`) or a bracketed IPv6
 * literal — followed by a 1–5 digit port.
 *
 * The host group deliberately excludes `:` and `/` OUTSIDE the bracketed form,
 * so a URL cannot slip through: `http://host:8888` is a scheme-qualified
 * endpoint nodeop would reject, and a permissive `\S+` accepted it as a "host"
 * of `http://host`. This is the scheme-less form every nodeop bind / advertise /
 * peer option takes — the same form {@link toAddress} builds.
 */
export const EndpointPattern = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):\d{1,5}$/


/**
 * Assert one `<address>:<port>` endpoint — shape first, then port range.
 *
 * SHAPE-only by design: the address may name an arbitrary deployment host this
 * process never resolves, dials, or binds, so nothing here probes the network or
 * claims a port from the bind registry.
 *
 * @param value - The endpoint as supplied.
 * @param label - The flag/field name, used verbatim in the failure message.
 * @throws If `value` is not `<address>:<port>`, or its port is out of range.
 */
export function assertEndpoint(value: string, label: string): void {
  Assert.ok(
    EndpointPattern.test(value),
    `${label} must be <address>:<port> — got '${value}'`
  )
  const port = Number(value.slice(value.lastIndexOf(":") + 1))
  Assert.ok(
    port >= MinimumPort && port <= MaximumPort,
    `${label} port must be ${MinimumPort}–${MaximumPort} — got ${port}`
  )
}

/**
 * Map a LISTEN address to a DIALABLE one: the non-dialable listen wildcard
 * ({@link ListenAllAddress} / empty) becomes {@link Localhost}; every other
 * address (loopback, a LAN IP, a remote RPC host) passes through verbatim. A
 * client cannot connect TO `0.0.0.0` — that means "listen on every interface",
 * so a daemon bound there is reached at the loopback. This generalizes the
 * `NodeConfigIniRenderer` advertise constraint (advertising `0.0.0.0` is
 * meaningless) and is the single mapper every dial/advertise site derives from.
 *
 * @param address - A bind/listen address (typically `config.bind.<daemon>.address`).
 * @returns The address a client should dial (or a node should advertise).
 * @example
 *   toDialAddress("0.0.0.0")   // "127.0.0.1"
 *   toDialAddress("127.0.0.1") // "127.0.0.1"
 *   toDialAddress("10.0.0.5")  // "10.0.0.5" (remote host, verbatim)
 */
export function toDialAddress(address: string): string {
  return address === ListenAllAddress ||
    address === ListenAllAddressV6 ||
    address.length === 0
    ? Localhost
    : address
}

/**
 * Check a registry candidate for IPv6 TCP listeners, independently of IPv4.
 * An IPv6 wildcard conflicts with specific IPv6 listeners, including v6-only
 * listeners that the allocator's IPv4 probe cannot see. Hosts with IPv6 disabled
 * have no IPv6 listener to collide with. Other errors fail closed.
 *
 * @param port - Candidate selected by BindConfigProvider.
 * @returns Whether IPv6 permits this candidate.
 */
export function isIpv6PortFree(port: number): Promise<boolean> {
  return Deferred.useCallback<boolean>(deferred => {
    const probe = Net.createServer()
    probe.once("error", (error: NodeJS.ErrnoException) => {
      guard(() => probe.close())
      deferred.resolve(
        error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL"
      )
    })
    probe.listen({ port, host: ListenAllAddressV6, ipv6Only: true }, () =>
      probe.close(() => deferred.resolve(true))
    )
  }).promise
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
  return Deferred.useCallback<boolean>(deferred => {
    const probe = Dgram.createSocket("udp4")
    probe.once("error", () => {
      guard(() => probe.close())
      deferred.resolve(false)
    })
    probe.bind(port, () => probe.close(() => deferred.resolve(true)))
  }).promise
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
  return output.split("\n").filter(line => {
    const local = line.trim().split(/\s+/)[4] ?? ""
    const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10)
    return Number.isFinite(port) && ports.has(port)
  })
}
