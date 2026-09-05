import Assert from "node:assert"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import Bluebird from "bluebird"
import { range } from "lodash"
import {
  BindConfigPortProtocol,
  type BindConfig,
  type BindConfigNodeopPorts,
  type BindConfigPortRange,
  type BindNodeopPortsOptions,
  type BindOptions,
  type ClusterTopologyOptions
} from "@wireio/cluster-tool-shared"
import {
  isUdpPortFree,
  ListenAllAddress,
  Localhost
} from "../utils/netUtils.js"
import { mkdirs, withFileLock } from "../utils/fsUtils.js"
import { isPidAlive, processCommandBasename } from "../utils/processUtils.js"
import { Deferred, getLogger, getValue, guard } from "@wireio/shared"

const log = getLogger(__filename)

type GetPortModuleType = typeof import("get-port")
type GetPortParameters = Parameters<GetPortModuleType["default"]>

let importGetPortModuleDeferred: Deferred<GetPortModuleType> = null

/**
 * `get-port` is ESM-only (`"type": "module"`) and this package emits CommonJS.
 * With `module: nodenext` TypeScript PRESERVES this dynamic `import()` (it is NOT
 * down-leveled to `require()`), so the ESM module loads at runtime and under
 * ts-jest. The default export is cached after first load. `get-port` bind-probes
 * every local host and LOCKS each returned port in-process for a short window, so
 * consecutive calls never return the same port — the parallel-run collision
 * safety this module exists to guarantee. It is the single primitive behind EVERY
 * port-finding path here (`findAvailable` / `pickPort` / `isPortAvailable`).
 */

function importGetPortModule(): Promise<GetPortModuleType> {
  if (importGetPortModuleDeferred === null) {
    importGetPortModuleDeferred = new Deferred()
    import("get-port").then(getPortModule =>
      importGetPortModuleDeferred.resolve(getPortModule)
    )
  }
  return importGetPortModuleDeferred.promise
}

/** Find an available port via `get-port` (see the note above). */
async function getPort(...args: GetPortParameters): Promise<number> {
  const mod = await importGetPortModule()
  return mod.default(...args)
}

/**
 * Resolves, validates, and registers cluster network bindings — the behavior
 * half of the plain-data `BindConfig` shape (`@wireio/cluster-tool-shared`).
 * Merges the resolver, the per-daemon defaults, and the cross-process port
 * registry: each `address` defaults to loopback (`ClusterBuildOptions.bindAll`
 * forces `0.0.0.0`); ports are either a caller's pinned value (which must be
 * free, or `resolve` throws) or a newly-claimed free port.
 */
export namespace BindConfigProvider {
  /** Basename of the mutex guarding port selection, inside the registry dir. */
  const PortLockFilename = "wire-cluster-ports.lock"

  /**
   * Lock path serializing port SELECTION across every process sharing a
   * registry. `get-port` only de-dupes within one process; this cross-process
   * advisory lock (via `withFileLock`) stops two processes racing the same free
   * port while finding it.
   *
   * It is deliberately derived from {@link registryPath} rather than pinned to
   * the OS temp dir: **a mutex must be scoped to the state it guards.** The
   * registry IS that state, and it is env-overridable
   * ({@link RegistryPathEnvVar}) — jest's setup gives every test file its own
   * `mkdtemp` registry so suites never read each other's reservations. A
   * host-global lock over per-worker registries produced pure FALSE contention:
   * 8 jest projects' port-resolving tests queued on one mutex while having
   * nothing to serialize against, and a rotating victim exhausted its retry
   * budget with `Lock file is already being held`.
   *
   * Production is unchanged: with the env var unset every process resolves the
   * same default registry, hence the same lock, and the cross-process guarantee
   * holds exactly as before.
   *
   * Living inside the registry dir is safe because every reader filters on
   * {@link RegistryFileSuffix}, so this file and the `.lock` directory
   * `proper-lockfile` creates beside it are never mistaken for registrations —
   * keep that filter if the reader is ever rewritten.
   */
  export function portLockPath(): string {
    return Path.join(registryPath(), PortLockFilename)
  }
  /**
   * agave's built-in validator port range — RESERVED host-wide; the harness
   * NEVER assigns a port inside it. A 4.x (solana-test-)validator binds
   * implicit sockets drawn first-free from this range REGARDLESS of
   * `--gossip-port` / `--dynamic-port-range` (verified 2026-07-15 via
   * `ss -ulpn`: an explicitly-ported validator still bound
   * `udp 0.0.0.0:8000`). Any harness claim inside the band can therefore be
   * stomped by a co-booting validator's implicit bind minutes after a
   * perfectly-valid locked+registered selection — two e2e gate runs lost
   * their wave-1 default-set flow to
   * `gossip_addr bind_to port 8000: Address already in use` exactly this
   * way. The band is seeded into EVERY exclusion set
   * ({@link readRegistryPortExclusions}), so no path — default preference,
   * ephemeral fallback, caller pin, or range window — can produce a port
   * inside it.
   */
  export const ReservedAgavePortBand: BindConfigPortRange = {
    first: 8_000,
    last: 10_000
  }
  // Daemon default preferences. Layout: everything lives in 10500-11999 —
  // above the reserved agave band, below the 12000+ dynamic-range windows,
  // far below the kernel's 32768+ ephemeral fallbacks. The pre-band values
  // are preserved as suffixes where possible (anvil 8545 → 10545, solana rpc
  // 8899 → 10899, ...). 10900 is deliberately UNASSIGNED: it is the solana
  // RPC's companion websocket port (rpc+1, bound by agave automatically —
  // see {@link BindConfigProvider.allPorts}).
  export const DefaultKiod = 10_890
  export const DefaultBiosHttp = 10_788
  export const DefaultBiosP2p = 10_776
  export const DefaultAnvil = 10_545
  export const DefaultSolanaRpc = 10_899
  export const DefaultSolanaFaucet = 10_990
  /**
   * Offset from the solana RPC port to its companion websocket port — agave
   * binds rpc+1 automatically, with no flag assigning it, so the RPC claim
   * covers both (see `claimSolanaHttp` in the resolver and
   * {@link BindConfigProvider.allPorts}).
   */
  export const SolanaWsPortOffset = 1
  /**
   * Preferred validator gossip port — outside {@link ReservedAgavePortBand}
   * like every other default; gossip is UDP, so its claim additionally
   * UDP-probes candidates (see {@link BindConfigPortProtocol}).
   */
  export const DefaultSolanaGossip = 11_000
  /**
   * Bounded redraws when resolving a port: candidates that land inside the
   * caller's claimed/exclusion set (an OS-assigned ephemeral can — see the
   * re-check in {@link pickPort}) or, for UDP-role ports, pass the TCP probe
   * but fail the UDP probe are excluded and redrawn up to this many times
   * before the resolve fails loudly. Raising it only matters on a host whose
   * port space is heavily squatted.
   */
  export const UdpPickAttempts = 16
  /**
   * First candidate port of the validator's `--dynamic-port-range` window.
   * Sits clear of every daemon default above and below the kernel's ephemeral
   * range; raising it shifts every cluster's candidate windows.
   */
  export const DefaultSolanaDynamicPortFirst = 12_000
  /**
   * Width of each validator dynamic-port window. agave binds ~19 dynamic
   * sockets (gossip/TPU/TVU/repair/broadcast); 64 leaves headroom for version
   * drift. Shrinking it below the validator's socket count breaks startup.
   */
  export const SolanaDynamicPortRangeSize = 64
  /**
   * Contiguous windows scanned (stepping by {@link SolanaDynamicPortRangeSize})
   * before `resolve` gives up — bounds the search to
   * `DefaultSolanaDynamicPortFirst + SearchLimit × RangeSize`.
   */
  export const SolanaDynamicPortRangeSearchLimit = 32
  export const DefaultDebuggingServer = 10_991
  /**
   * Preferred HTTP port of an AD-HOC node — one a flow provisions after
   * `NodeConfig.plan` (an operator daemon, or a collateral-backed producer's
   * own node). A PREFERENCE only, placed in the daemon-default layout above:
   * {@link findAvailableAdHocPorts} takes it when free and an ephemeral port
   * otherwise, so two ad-hoc nodes never collide on it.
   */
  export const DefaultAdHocHttp = 10_988
  /** Preferred p2p port of an ad-hoc node (see {@link DefaultAdHocHttp}). */
  export const DefaultAdHocP2p = 10_976
  export const DefaultProducerCount = 1
  export const DefaultBatchCount = 3
  export const DefaultUnderwriterCount = 1

  /**
   * Resolve a complete `BindConfig` from caller options. Addresses come from
   * `bindAll` / per-daemon overrides; every port is the caller's pinned value
   * (which must be free) or a newly-claimed free port (never colliding within
   * one resolve).
   *
   * @param options - Caller binding overrides.
   * @param topology - Node counts + bind-all flag.
   * @returns The fully-resolved binding.
   */
  export function resolve(
    options: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    // Hold the host-global port lock for the WHOLE cluster port selection so a
    // parallel process cannot interleave and pick an overlapping set (get-port
    // only de-dupes within one process — see portLockPath()).
    return withFileLock(portLockPath(), () => resolveLocked(options, topology))
  }

  /** {@link resolve} body — always runs under the {@link portLockPath} lock. */
  async function resolveLocked(
    options: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    const host = topology.bindAll ? ListenAllAddress : Localhost,
      addr = (daemon: keyof BindOptions): string =>
        options[daemon]?.address ?? host,
      // Seed the exclusion set with every LIVE process's registered ports —
      // a port get-port reports free is still reserved when another process
      // resolved it but hasn't bound its daemons yet (they spawn minutes
      // later). Dead registrants are reaped during the read.
      claimed = readRegistryPortExclusions(),
      claim = async (
        callerPin: number | null,
        fallbackDefault: number | null,
        daemon: string,
        protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp
      ): Promise<number> => {
        const port = await pickPort(
          callerPin,
          fallbackDefault,
          claimed,
          daemon,
          protocol
        )
        claimed.add(port)
        return port
      },
      pair = async (
        base: BindNodeopPortsOptions | null,
        daemon: string
      ): Promise<BindConfigNodeopPorts> => ({
        http: await claim(base?.http ?? null, null, `${daemon}.http`),
        p2p: await claim(base?.p2p ?? null, null, `${daemon}.p2p`),
        // Per-node advertise address (multi-host mesh): a REMOTE address —
        // carried through verbatim, never probed. Conditional spread so the
        // single-host default persists with no key at all.
        ...(base?.advertiseAddress != null
          ? { advertiseAddress: base.advertiseAddress }
          : {})
      }),
      pairs = (
        bases: BindNodeopPortsOptions[] | null,
        count: number,
        daemon: string
      ): Promise<BindConfigNodeopPorts[]> =>
        Bluebird.mapSeries(range(count), i =>
          pair(bases?.[i] ?? null, `${daemon}[${i}]`)
        ),
      // agave binds the RPC's companion websocket at rpc+1 AUTOMATICALLY (no
      // flag assigns it) — claiming the RPC port claims BOTH, so no daemon in
      // this resolve and no other cluster via the registry is ever handed the
      // companion.
      claimSolanaHttp = async (): Promise<number> => {
        const http = await claim(
          options.solana?.ports?.http ?? null,
          DefaultSolanaRpc,
          "solana.http"
        )
        claimed.add(http + SolanaWsPortOffset)
        return http
      },
      // The window's ports are claimed individually so every later pick in
      // this resolve — and every other resolver via the registry — excludes
      // the whole window, not just its first port.
      claimSolanaDynamicRange = async (): Promise<BindConfigPortRange> => {
        const dynamicRange = await pickPortRange(
          options.solana?.ports?.dynamicRange ?? null,
          claimed,
          "solana.dynamicRange"
        )
        range(dynamicRange.first, dynamicRange.last + 1).forEach(port =>
          claimed.add(port)
        )
        return dynamicRange
      }

    const nodeopPorts = options.nodeop?.ports,
      {
        producerCount = DefaultProducerCount,
        batchOperatorCount: batchCount = DefaultBatchCount,
        underwriterCount: uwCount = DefaultUnderwriterCount
      } = topology

    const resolved: BindConfig = {
      kiod: {
        address: addr("kiod"),
        port: await claim(options.kiod?.port ?? null, DefaultKiod, "kiod")
      },
      nodeop: {
        address: addr("nodeop"),
        ports: {
          bios: {
            http: await claim(
              nodeopPorts?.bios?.http ?? null,
              DefaultBiosHttp,
              "nodeop.bios.http"
            ),
            p2p: await claim(
              nodeopPorts?.bios?.p2p ?? null,
              DefaultBiosP2p,
              "nodeop.bios.p2p"
            ),
            // Same verbatim carry-through as `pair` — see the note there.
            ...(nodeopPorts?.bios?.advertiseAddress != null
              ? { advertiseAddress: nodeopPorts.bios.advertiseAddress }
              : {})
          },
          producers: await pairs(
            nodeopPorts?.producers ?? null,
            producerCount,
            "producer"
          ),
          batch: await pairs(nodeopPorts?.batch ?? null, batchCount, "batch"),
          underwriters: await pairs(
            nodeopPorts?.underwriters ?? null,
            uwCount,
            "underwriter"
          )
        }
      },
      anvil: {
        address: addr("anvil"),
        port: await claim(options.anvil?.port ?? null, DefaultAnvil, "anvil")
      },
      solana: {
        address: addr("solana"),
        ports: {
          http: await claimSolanaHttp(),
          faucet: await claim(
            options.solana?.ports?.faucet ?? null,
            DefaultSolanaFaucet,
            "solana.faucet"
          ),
          // agave 4.x binds the test validator's gossip socket at its FIXED
          // default (8000) instead of carving it from --dynamic-port-range,
          // so every parallel validator needs an explicit per-cluster
          // --gossip-port. Cross-cluster disjointness comes from the same
          // machinery as every other port: the file-locked registry feeds
          // `claim`'s exclusions, so no two clusters ever resolve the same
          // gossip port. Gossip is a UDP socket — the claim additionally
          // UDP-probes candidates, catching non-registry UDP holders that
          // get-port's TCP probe cannot see.
          gossip: await claim(
            options.solana?.ports?.gossip ?? null,
            DefaultSolanaGossip,
            "solana.gossip",
            BindConfigPortProtocol.udp
          ),
          dynamicRange: await claimSolanaDynamicRange()
        }
      },
      debuggingServer: {
        address: addr("debuggingServer"),
        port: await claim(
          options.debuggingServer?.port ?? null,
          DefaultDebuggingServer,
          "debuggingServer"
        )
      }
    }
    // Register BEFORE the lock releases: the next resolver (any process) must
    // see these ports as reserved even though no daemon has bound them yet.
    registerResolved(resolved)
    return resolved
  }

  /**
   * Flat list of every port of a resolved binding, for validation and registry
   * exclusion — the ONE port walker over the `BindConfig` shape.
   *
   * @param config - The resolved binding.
   * @returns Every claimed port, including agave's implicit rpc+1 websocket.
   */
  export function allPorts(config: BindConfig): number[] {
    const np = config.nodeop.ports,
      flat = (xs: BindConfigNodeopPorts[]) => xs.flatMap(p => [p.http, p.p2p]),
      dynamicRange = config.solana.ports.dynamicRange
    return [
      config.kiod.port,
      np.bios.http,
      np.bios.p2p,
      ...flat(np.producers),
      ...flat(np.batch),
      ...flat(np.underwriters),
      config.anvil.port,
      config.solana.ports.http,
      // The RPC's companion websocket — agave binds rpc+1 automatically (no
      // flag assigns it); it rides allPorts so the registry excludes it for
      // every other resolver.
      config.solana.ports.http + SolanaWsPortOffset,
      config.solana.ports.faucet,
      config.solana.ports.gossip,
      ...range(dynamicRange.first, dynamicRange.last + 1),
      config.debuggingServer.port
    ]
  }

  /**
   * Every claimed port QUALIFIED BY THE HOST that binds it, as `host:port`.
   *
   * Uniqueness is a per-HOST property, never a global one, and conflating the
   * two makes a valid multi-host deployment unrepresentable. On a local cluster
   * every daemon shares one machine, so {@link allPorts} being globally distinct
   * happens to be the same statement. On an EXTERNAL cluster it is not: each
   * nodeop runs on its own host and every one of them correctly binds the
   * standard `8888`/`9876`.
   *
   * A 43-identity external bind config (21 producers on `10.60.1.x`, 21 batch
   * operators on `10.60.2.x`, 1 underwriter on `10.60.3.x`) is exactly that
   * shape, and a global-uniqueness check rejects it — which is what failed
   * `create-external-config` on 2026-08-04 after the bootstrap itself passed.
   *
   * Per-node ports are scoped by the node's `advertiseAddress` (where it is
   * REACHED); the singleton daemons by their own bind address.
   *
   * @param config - The resolved binding.
   * @returns One `host:port` key per claimed port.
   */
  export function allPortBindings(config: BindConfig): string[] {
    const np = config.nodeop.ports,
      dynamicRange = config.solana.ports.dynamicRange,
      at = (host: string, port: number) => `${host}:${port}`,
      // A node's ports belong to the host it advertises; when a bind config
      // omits it (single-host local clusters), the shared nodeop bind address
      // is the honest answer and global uniqueness is restored for free.
      nodeAt = (node: BindConfigNodeopPorts) =>
        [node.http, node.p2p].map(port =>
          at(node.advertiseAddress ?? config.nodeop.address, port)
        ),
      flat = (nodes: BindConfigNodeopPorts[]) => nodes.flatMap(nodeAt)
    return [
      at(config.kiod.address, config.kiod.port),
      ...nodeAt(np.bios),
      ...flat(np.producers),
      ...flat(np.batch),
      ...flat(np.underwriters),
      at(config.anvil.address, config.anvil.port),
      ...[
        config.solana.ports.http,
        config.solana.ports.http + SolanaWsPortOffset,
        config.solana.ports.faucet,
        config.solana.ports.gossip,
        ...range(dynamicRange.first, dynamicRange.last + 1)
      ].map(port => at(config.solana.address, port)),
      at(config.debuggingServer.address, config.debuggingServer.port)
    ]
  }

  /**
   * True iff every port of an already-resolved binding is currently free.
   *
   * @param config - The resolved binding to re-probe.
   * @returns Whether all ports are available.
   */
  export async function validate(config: BindConfig): Promise<boolean> {
    // The resolved ports were locked in get-port's in-process cache at resolve
    // time; clear it so each isPortAvailable re-probes true OS bindability.
    await clearPortLocks()
    const taken = await Bluebird.filter(
      allPorts(config),
      async port => !(await isPortAvailable(port)),
      { concurrency: 1 }
    )
    return taken.length === 0
  }

  // ── cross-process port registry ────────────────────────────────────────
  //
  // `get-port` + the file lock serialize port SELECTION, but a selected port
  // is not BOUND until its daemon spawns (possibly minutes later) — a second
  // process resolving in that window would re-pick it. Each resolving process
  // therefore registers its full resolved BindConfig in a host-global registry
  // file BEFORE the lock releases; later resolvers (still under the lock)
  // read every LIVE registration into their exclusion set. Files are removed
  // on process exit; a SIGKILL'd process's file is reaped by the next reader
  // (pid liveness + recycled-pid basename guard).

  /** Env override for the registry dir — unit tests point it at a scratch dir. */
  export const RegistryPathEnvVar = "WIRE_BIND_REGISTRY_PATH"
  /** Registry file suffix: `<pid>.bind-config.json`. */
  export const RegistryFileSuffix = ".bind-config.json"
  /**
   * Every registrant is a Node.js process (a FlowCLI executable,
   * `wire-cluster-tool`, or a jest worker) — a live pid running anything else
   * is a recycled pid wearing a stale registry file.
   */
  const RegistrantBasename = "node"

  /** The host-global registry dir (env-overridable for tests). */
  export function registryPath(): string {
    return (
      process.env[RegistryPathEnvVar] ??
      Path.join(Os.tmpdir(), "wire-platform-bind-config")
    )
  }

  /** THIS process's registry file — an ARRAY of resolved BindConfigs. */
  export function registryFile(): string {
    return Path.join(registryPath(), `${process.pid}${RegistryFileSuffix}`)
  }

  /**
   * Every LIVE registration's ports, reaping stale files as they are found: a
   * registry file whose pid is gone, or whose pid no longer runs `node`
   * (recycled), or whose content does not parse, is DELETED instead of
   * honored. A live pid whose `/proc` is unreadable (another user's process)
   * is kept conservatively. Call only under the
   * {@link BindConfigProvider.portLockPath} lock — read/reap/resolve/write
   * must be one critical section.
   *
   * The set is SEEDED with {@link ReservedAgavePortBand} — the band is a
   * standing registration on behalf of every validator's implicit binds, so
   * no picker downstream of this read can ever assign inside it.
   *
   * @returns The union of the reserved band and every live registration's ports.
   */
  export function readRegistryPortExclusions(): Set<number> {
    const dir = registryPath()
    mkdirs(dir)
    const exclusions = new Set<number>(
      range(ReservedAgavePortBand.first, ReservedAgavePortBand.last + 1)
    )
    Fs.readdirSync(dir)
      .filter(fileName => fileName.endsWith(RegistryFileSuffix))
      .forEach(fileName => {
        const filePath = Path.join(dir, fileName),
          pid = Number.parseInt(fileName, 10),
          basename = Number.isFinite(pid) ? processCommandBasename(pid) : "",
          alive = Number.isFinite(pid) && isPidAlive(pid),
          // "" basename + alive = unreadable /proc (foreign user) → keep.
          recycled = alive && basename !== "" && basename !== RegistrantBasename
        if (!alive || recycled) {
          log.info(
            `bind registry: reaping stale ${fileName} (${!alive ? "pid gone" : `pid recycled to ${basename}`})`
          )
          guard(() => Fs.rmSync(filePath, { force: true }))
          return
        }
        const entries = getValue(
          () => JSON.parse(Fs.readFileSync(filePath, "utf8")) as unknown,
          null
        )
        if (!Array.isArray(entries)) {
          log.warn(`bind registry: reaping malformed ${fileName}`)
          guard(() => Fs.rmSync(filePath, { force: true }))
          return
        }
        entries.forEach(entry => {
          // Walked via allPorts so it stays the ONE port walker over the
          // plain-data BindConfig shape.
          const ports = getValue(
            () => allPorts(entry as BindConfig),
            [] as number[]
          )
          if (ports.length === 0) {
            log.warn(`bind registry: ignoring malformed entry in ${fileName}`)
          }
          ports.forEach(port => exclusions.add(port))
        })
      })
    return exclusions
  }

  let registryExitCleanupArmed = false

  /**
   * Append `config` to THIS process's registry file and arm the exit cleanup
   * (once). One file per pid, holding an array — a process that resolves
   * several clusters (the harness's jest suite) accumulates its reservations;
   * they all release together when the process exits. SIGINT/SIGTERM funnel
   * through `process.exit` (the ProcessManager signal handlers), which fires
   * the `exit` hook; a SIGKILL leaves the file for the next reader's reaper.
   *
   * @param config - The just-resolved binding to register.
   */
  export function registerResolved(config: BindConfig): void {
    mkdirs(registryPath())
    const file = registryFile(),
      existing = getValue(
        () => JSON.parse(Fs.readFileSync(file, "utf8")) as unknown,
        null
      ),
      entries: unknown[] = Array.isArray(existing) ? existing : []
    entries.push(config)
    Fs.writeFileSync(file, JSON.stringify(entries, null, 2))
    if (!registryExitCleanupArmed) {
      registryExitCleanupArmed = true
      process.on("exit", () =>
        guard(() => Fs.rmSync(registryFile(), { force: true }))
      )
    }
  }

  /**
   * Drop `get-port`'s in-process port locks so a subsequent check re-probes
   * true OS bindability.
   *
   * Every picker here — {@link findAvailable}, {@link isPortAvailable},
   * {@link resolve} — LOCKS whatever port it hands back, as get-port's
   * collision avoidance. That lock is per-process and invisible to the OS, so
   * a port this process legitimately reserved reads as "taken" to its own
   * later probes. Callers that must RE-acquire a port they already resolved
   * — {@link validate} re-verifying a resolved binding, or a caller feeding a
   * registry-vetted port back in as a PIN — clear the locks first.
   *
   * Cross-process safety is unaffected: the file registry
   * ({@link readRegistryPortExclusions}) is the cross-process guard, and it is
   * untouched by this call.
   */
  export async function clearPortLocks(): Promise<void> {
    const mod = await importGetPortModule()
    mod.clearLockedPorts()
  }

  /**
   * True if `port` is bindable right now, via `get-port` (asks it for exactly
   * `port`; a differing result means `port` is taken or already locked in
   * get-port's cache). NOTE: a `true` result LOCKS `port` in get-port's
   * in-process cache (its collision-avoidance) — to re-check an already-resolved
   * port, call {@link clearPortLocks} first (see {@link BindConfigProvider.validate}).
   *
   * @param port - Port to probe.
   * @returns Whether the port is free.
   */
  export async function isPortAvailable(port: number): Promise<boolean> {
    return withFileLock(
      portLockPath(),
      async () => (await getPort({ port })) === port
    )
  }

  /**
   * Resolve an AVAILABLE port via `get-port`, preferring `preferred`. Returns
   * `preferred` when it is free right now, otherwise a get-port-assigned free
   * port. Use this ANYWHERE a bind port / URL is produced — harness code AND
   * tests. The default port is only a PREFERENCE; never commit to a fixed port,
   * which collides across concurrent processes / test runs. READS the
   * cross-process registry (another process's resolved-but-not-yet-bound ports
   * count as taken) but never writes it — only {@link BindConfigProvider.resolve}
   * registers.
   *
   * @param preferred - The preferred port (e.g. `BindConfigProvider.DefaultAnvil`).
   * @param protocol - Transport the port will be bound with; UDP-role ports
   *   (validator gossip) are additionally UDP-probed.
   * @returns A currently-free port (the preferred one when possible).
   */
  export async function findAvailable(
    preferred: number,
    protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp
  ): Promise<number> {
    return withFileLock(portLockPath(), () =>
      pickPort(
        null,
        preferred,
        readRegistryPortExclusions(),
        "findAvailable",
        protocol
      )
    )
  }

  /**
   * The registry-issued `http` + `p2p` pair an AD-HOC node binds — each port
   * resolved through {@link findAvailable} from the ad-hoc preferences
   * ({@link DefaultAdHocHttp} / {@link DefaultAdHocP2p}), so the pair is claimed
   * under the same host-global lock as every planned node's.
   *
   * @returns The node's binding.
   */
  export async function findAvailableAdHocPorts(): Promise<BindConfigNodeopPorts> {
    return {
      http: await findAvailable(DefaultAdHocHttp),
      p2p: await findAvailable(DefaultAdHocP2p)
    }
  }

  /**
   * Resolve one port via `get-port`: a caller-pinned port must be free +
   * unclaimed (else THROW); otherwise `fallbackDefault` is preferred when free,
   * falling back to any free port. `claimed` is passed to get-port as `exclude`
   * so no two daemons in one resolve share a port (get-port also locks each
   * returned port in-process as a second guard).
   *
   * @param callerPin - The caller's pinned port, or null.
   * @param fallbackDefault - The preferred default port, or null.
   * @param claimed - Ports already claimed within this resolve (`exclude` set).
   * @param daemon - Label for the error message.
   * @returns The resolved port.
   * @throws If `callerPin` is pinned but unavailable.
   */
  export async function pickPort(
    callerPin: number | null,
    fallbackDefault: number | null,
    claimed: Set<number>,
    daemon: string,
    protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp
  ): Promise<number> {
    if (callerPin !== null) {
      Assert.ok(
        !isReservedPort(callerPin),
        `port ${callerPin} for ${daemon} is inside the reserved agave validator band ` +
          `${ReservedAgavePortBand.first}-${ReservedAgavePortBand.last} ` +
          `(agave binds implicit sockets there regardless of flags) — pin a port outside it`
      )
      const resolved = await getPort({ port: callerPin, exclude: claimed })
      Assert.ok(
        resolved === callerPin &&
          (protocol === BindConfigPortProtocol.tcp ||
            (await isUdpPortFree(callerPin))),
        `port ${callerPin} for ${daemon} is pinned but unavailable`
      )
      return callerPin
    }
    // First draw prefers the default; a candidate is redrawn when it sits in
    // `claimed` or (for UDP-role ports) fails the UDP probe. The claimed
    // re-check is load-bearing: get-port consults `exclude` only for EXPLICIT
    // candidates — its port-0 (OS-assigned) fallback returns without checking
    // it, so the OS can hand back a port another process resolved but has not
    // bound yet (registered daemons spawn minutes after their resolve). The
    // rejected candidate stays locked in get-port's in-process cache, so no
    // later draw can re-offer it.
    const picked = await Bluebird.reduce(
      range(0, UdpPickAttempts),
      async (found: number | null, attempt: number) => {
        if (found !== null) return found
        const candidate = await getPort(
          attempt === 0 && fallbackDefault !== null
            ? { port: fallbackDefault, exclude: claimed }
            : { exclude: claimed }
        )
        return !claimed.has(candidate) &&
          (protocol === BindConfigPortProtocol.tcp ||
            (await isUdpPortFree(candidate)))
          ? candidate
          : null
      },
      null as number | null
    )
    Assert.ok(
      picked !== null,
      `no free unclaimed port found for ${daemon} within ${UdpPickAttempts} attempts`
    )
    return picked
  }

  /** Whether `port` sits inside {@link ReservedAgavePortBand}. */
  function isReservedPort(port: number): boolean {
    return (
      port >= ReservedAgavePortBand.first && port <= ReservedAgavePortBand.last
    )
  }

  /**
   * Whether EVERY port of the window starting at `first` is free: not in
   * `exclusions` (the file-locked registry + this resolve's claims — the
   * cross-process coordination surface), available per `get-port` (TCP), AND
   * UDP-bindable. The window is consumed by the validator's dynamic sockets,
   * which are predominantly UDP — a UDP-only squatter inside a candidate
   * window is invisible to the TCP probe and panics agave at first bind.
   *
   * @param first - First port of the candidate window.
   * @param exclusions - Ports already claimed/registered.
   * @returns Whether the whole window is free.
   */
  async function isRangeFree(
    first: number,
    exclusions: Set<number>
  ): Promise<boolean> {
    const ports = range(first, first + SolanaDynamicPortRangeSize)
    if (ports.some(port => exclusions.has(port))) return false
    const taken = await Bluebird.filter(
      ports,
      async port =>
        (await getPort({ port })) !== port || !(await isUdpPortFree(port)),
      { concurrency: 1 }
    )
    return taken.length === 0
  }

  /**
   * Resolve a free contiguous {@link SolanaDynamicPortRangeSize}-port window: a
   * caller-pinned range must be entirely free (else THROW, mirroring
   * {@link pickPort}); otherwise candidate windows are scanned from
   * {@link DefaultSolanaDynamicPortFirst}. Call only under the
   * {@link BindConfigProvider.portLockPath} lock (resolve does).
   *
   * @param callerPin - The caller's pinned window, or null.
   * @param exclusions - Ports already claimed/registered.
   * @param daemon - Label for the error message.
   * @returns The resolved window.
   * @throws If pinned-but-unavailable, or no free window within the search limit.
   */
  export async function pickPortRange(
    callerPin: BindConfigPortRange | null,
    exclusions: Set<number>,
    daemon: string
  ): Promise<BindConfigPortRange> {
    if (callerPin !== null) {
      Assert.ok(
        callerPin.first > ReservedAgavePortBand.last ||
          callerPin.last < ReservedAgavePortBand.first,
        `port range ${callerPin.first}-${callerPin.last} for ${daemon} overlaps the reserved agave validator band ` +
          `${ReservedAgavePortBand.first}-${ReservedAgavePortBand.last} ` +
          `(agave binds implicit sockets there regardless of flags) — pin a window outside it`
      )
      Assert.ok(
        await isRangeFree(callerPin.first, exclusions),
        `port range ${callerPin.first}-${callerPin.last} for ${daemon} is pinned but unavailable`
      )
      return callerPin
    }
    const starts = range(0, SolanaDynamicPortRangeSearchLimit).map(
      i => DefaultSolanaDynamicPortFirst + i * SolanaDynamicPortRangeSize
    )
    const first = await Bluebird.reduce(
      starts,
      async (found: number | null, start) =>
        found ?? ((await isRangeFree(start, exclusions)) ? start : null),
      null as number | null
    )
    Assert.ok(
      first !== null,
      `no free ${SolanaDynamicPortRangeSize}-port window for ${daemon} within ` +
        `${SolanaDynamicPortRangeSearchLimit} windows from ${DefaultSolanaDynamicPortFirst}`
    )
    return { first, last: first + SolanaDynamicPortRangeSize - 1 }
  }

  /**
   * Resolve an available validator dynamic-port window OUTSIDE a full
   * `resolve` — the standalone counterpart of {@link findAvailable} (e.g.
   * `SolanaValidatorProcess.create` without a cluster BindConfig). Reads the
   * cross-process registry for exclusions under the host-global port lock.
   *
   * @returns A currently-free window.
   */
  export async function findAvailableRange(): Promise<BindConfigPortRange> {
    return withFileLock(portLockPath(), () =>
      pickPortRange(null, readRegistryPortExclusions(), "solana.dynamicRange")
    )
  }
}
