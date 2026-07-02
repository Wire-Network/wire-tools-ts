import Assert from "node:assert"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import Bluebird from "bluebird"
import { range } from "lodash"
import { ListenAllAddress, Localhost } from "../utils/netUtils.js"
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
    import("get-port").then((getPortModule)=>
        importGetPortModuleDeferred.resolve(getPortModule))
  }
  return importGetPortModuleDeferred.promise
}



/** Find an available port via `get-port` (see the note above). */
async function getPort(
  ...args: GetPortParameters
): Promise<number> {
  const mod = await importGetPortModule()
  return mod.default(...args)
}

/**
 * Drop `get-port`'s in-process port locks so a subsequent check re-probes true OS
 * bindability. Used by {@link BindConfig.validate} to re-verify the already-
 * resolved (therefore already-locked) ports.
 */
async function clearPortLocks(): Promise<void> {
  const mod = await importGetPortModule()
  mod.clearLockedPorts()
}

/** One nodeop's `{ http, p2p }` listen ports. */
export interface BindConfigNodeopPorts {
  http: number
  p2p: number
}

/** The full nodeop port set across the cluster (one pair per node, per role). */
export interface BindConfigNodeopClusterPorts {
  bios: BindConfigNodeopPorts
  producers: BindConfigNodeopPorts[]
  batch: BindConfigNodeopPorts[]
  underwriters: BindConfigNodeopPorts[]
}

/** A daemon that listens on one address + one port (kiod, anvil, debuggingServer). */
export interface BindConfigDaemon {
  address: string
  port: number
}

/** nodeop: one bind address, the cluster-wide nodeop port set. */
export interface BindConfigNodeop {
  address: string
  ports: BindConfigNodeopClusterPorts
}

/** solana ports — `http` is the RPC port, `faucet` the airdrop faucet. */
export interface BindConfigSolanaPorts {
  http: number
  faucet: number
}

export interface BindConfigSolana {
  address: string
  ports: BindConfigSolanaPorts
}

/** Caller BIND options for a single-port daemon. NOT a `Partial<BindConfig>`. */
export interface BindDaemonOptions {
  address?: string
  port?: number
}
export interface BindNodeopPortsOptions {
  http?: number
  p2p?: number
}
export interface BindNodeopClusterPortsOptions {
  bios?: BindNodeopPortsOptions
  producers?: BindNodeopPortsOptions[]
  batch?: BindNodeopPortsOptions[]
  underwriters?: BindNodeopPortsOptions[]
}
export interface BindNodeopOptions {
  address?: string
  ports?: BindNodeopClusterPortsOptions
}
export interface BindSolanaPortsOptions {
  http?: number
  faucet?: number
}
export interface BindSolanaOptions {
  address?: string
  ports?: BindSolanaPortsOptions
}

/** Caller-facing binding options (all optional; `BindConfig.resolve` fills the rest). */
export interface BindOptions {
  kiod?: BindDaemonOptions
  nodeop?: BindNodeopOptions
  anvil?: BindDaemonOptions
  solana?: BindSolanaOptions
  debuggingServer?: BindDaemonOptions
}

/** Topology + bind-all the port resolver needs (counts mirror ClusterBuildOptions). */
export interface ClusterTopologyOptions {
  producerCount?: number
  batchOperatorCount?: number
  underwriterCount?: number
  bindAll?: boolean
}

/**
 * Per-daemon network binding for a cluster — addresses + ports in one place
 * (merges the former `BindConfig` + `ClusterPorts`). Each `address` defaults to
 * loopback; `ClusterBuildOptions.bindAll` forces every address to `0.0.0.0`.
 * Ports are either a caller's pinned value (which must be free, or `resolve`
 * throws) or a newly-claimed free port.
 */
export class BindConfig {
  constructor(
    readonly kiod: BindConfigDaemon,
    readonly nodeop: BindConfigNodeop,
    readonly anvil: BindConfigDaemon,
    readonly solana: BindConfigSolana,
    readonly debuggingServer: BindConfigDaemon
  ) {}

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
  static resolve(
    options: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    // Hold the host-global port lock for the WHOLE cluster port selection so a
    // parallel process cannot interleave and pick an overlapping set (get-port
    // only de-dupes within one process — see PortLockPath).
    return withFileLock(BindConfig.PortLockPath, () =>
      BindConfig.resolveLocked(options, topology)
    )
  }

  /** {@link resolve} body — always runs under the {@link BindConfig.PortLockPath} lock. */
  private static async resolveLocked(
    options: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    const host = topology.bindAll
        ? BindConfig.BindAllAddress
        : BindConfig.LoopbackAddress,
      addr = (daemon: keyof BindOptions): string =>
        options[daemon]?.address ?? host,
      // Seed the exclusion set with every LIVE process's registered ports —
      // a port get-port reports free is still reserved when another process
      // resolved it but hasn't bound its daemons yet (they spawn minutes
      // later). Dead registrants are reaped during the read.
      claimed = BindConfig.readRegistryPortExclusions(),
      claim = async (
        callerPin: number | null,
        fallbackDefault: number | null,
        daemon: string
      ): Promise<number> => {
        const port = await BindConfig.pickPort(
          callerPin,
          fallbackDefault,
          claimed,
          daemon
        )
        claimed.add(port)
        return port
      },
      pair = async (
        base: BindNodeopPortsOptions | null,
        daemon: string
      ): Promise<BindConfigNodeopPorts> => ({
        http: await claim(base?.http ?? null, null, `${daemon}.http`),
        p2p: await claim(base?.p2p ?? null, null, `${daemon}.p2p`)
      }),
      pairs = (
        bases: BindNodeopPortsOptions[] | null,
        count: number,
        daemon: string
      ): Promise<BindConfigNodeopPorts[]> =>
        Bluebird.mapSeries(range(count), i =>
          pair(bases?.[i] ?? null, `${daemon}[${i}]`)
        )

    const nodeopPorts = options.nodeop?.ports,
      producerCount = topology.producerCount ?? BindConfig.DefaultProducerCount,
      batchCount = topology.batchOperatorCount ?? BindConfig.DefaultBatchCount,
      uwCount = topology.underwriterCount ?? BindConfig.DefaultUnderwriterCount

    const resolved = new BindConfig(
      {
        address: addr("kiod"),
        port: await claim(options.kiod?.port ?? null, BindConfig.DefaultKiod, "kiod")
      },
      {
        address: addr("nodeop"),
        ports: {
          bios: {
            http: await claim(
              nodeopPorts?.bios?.http ?? null,
              BindConfig.DefaultBiosHttp,
              "nodeop.bios.http"
            ),
            p2p: await claim(
              nodeopPorts?.bios?.p2p ?? null,
              BindConfig.DefaultBiosP2p,
              "nodeop.bios.p2p"
            )
          },
          producers: await pairs(nodeopPorts?.producers ?? null, producerCount, "producer"),
          batch: await pairs(nodeopPorts?.batch ?? null, batchCount, "batch"),
          underwriters: await pairs(
            nodeopPorts?.underwriters ?? null,
            uwCount,
            "underwriter"
          )
        }
      },
      {
        address: addr("anvil"),
        port: await claim(options.anvil?.port ?? null, BindConfig.DefaultAnvil, "anvil")
      },
      {
        address: addr("solana"),
        ports: {
          http: await claim(
            options.solana?.ports?.http ?? null,
            BindConfig.DefaultSolanaRpc,
            "solana.http"
          ),
          faucet: await claim(
            options.solana?.ports?.faucet ?? null,
            BindConfig.DefaultSolanaFaucet,
            "solana.faucet"
          )
        }
      },
      {
        address: addr("debuggingServer"),
        port: await claim(
          options.debuggingServer?.port ?? null,
          BindConfig.DefaultDebuggingServer,
          "debuggingServer"
        )
      }
    )
    // Register BEFORE the lock releases: the next resolver (any process) must
    // see these ports as reserved even though no daemon has bound them yet.
    BindConfig.registerResolved(resolved)
    return resolved
  }

  /** Flat list of every port, for validation. */
  get allPorts(): number[] {
    const np = this.nodeop.ports,
      flat = (xs: BindConfigNodeopPorts[]) => xs.flatMap(p => [p.http, p.p2p])
    return [
      this.kiod.port,
      np.bios.http,
      np.bios.p2p,
      ...flat(np.producers),
      ...flat(np.batch),
      ...flat(np.underwriters),
      this.anvil.port,
      this.solana.ports.http,
      this.solana.ports.faucet,
      this.debuggingServer.port
    ]
  }

  /**
   * True iff every resolved port is currently free.
   *
   * @returns Whether all ports are available.
   */
  async validate(): Promise<boolean> {
    // The resolved ports were locked in get-port's in-process cache at resolve
    // time; clear it so each isPortAvailable re-probes true OS bindability.
    await clearPortLocks()
    const taken = await Bluebird.filter(
      this.allPorts,
      async port => !(await BindConfig.isPortAvailable(port)),
      { concurrency: 1 }
    )
    return taken.length === 0
  }
}

export namespace BindConfig {
  /** Loopback listen address (the default) — sourced from `netUtils.Localhost`. */
  export const LoopbackAddress = Localhost
  /** Bind-all listen address (`options.bindAll`) — sourced from `netUtils.ListenAllAddress`. */
  export const BindAllAddress = ListenAllAddress
  /**
   * Host-global lock path serializing port SELECTION across every wire process
   * (parallel `flow-*` / `wire-test-cluster` runs). `get-port` only de-dupes
   * within one process; this cross-process advisory lock (via `withFileLock`)
   * stops two processes racing the same free port while finding it. Shared by
   * ALL processes on the host, so it lives under the OS temp dir, not a cluster
   * path.
   */
  export const PortLockPath = Path.join(Os.tmpdir(), "wire-cluster-ports.lock")
  export const DefaultKiod = 8900
  export const DefaultBiosHttp = 8788
  export const DefaultBiosP2p = 9776
  export const DefaultAnvil = 8545
  export const DefaultSolanaRpc = 8899
  export const DefaultSolanaFaucet = 9900
  export const DefaultDebuggingServer = 9901
  export const DefaultProducerCount = 1
  export const DefaultBatchCount = 3
  export const DefaultUnderwriterCount = 1

  /**
   * True if `port` is bindable right now, via `get-port` (asks it for exactly
   * `port`; a differing result means `port` is taken or already locked in
   * get-port's cache). NOTE: a `true` result LOCKS `port` in get-port's
   * in-process cache (its collision-avoidance) — to re-check an already-resolved
   * port, call `clearPortLocks()` first (see {@link BindConfig.validate}).
   *
   * @param port - Port to probe.
   * @returns Whether the port is free.
   */
  export async function isPortAvailable(port: number): Promise<boolean> {
    return withFileLock(
      BindConfig.PortLockPath,
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
   * count as taken) but never writes it — only {@link BindConfig.resolve}
   * registers.
   *
   * @param preferred - The preferred port (e.g. `BindConfig.DefaultAnvil`).
   * @returns A currently-free port (the preferred one when possible).
   */
  export async function findAvailable(preferred: number): Promise<number> {
    return withFileLock(BindConfig.PortLockPath, () =>
      getPort({ port: preferred, exclude: readRegistryPortExclusions() })
    )
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
   * `wire-test-cluster`, or a jest worker) — a live pid running anything else
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
   * is kept conservatively. Call only under the {@link BindConfig.PortLockPath}
   * lock — read/reap/resolve/write must be one critical section.
   *
   * @returns The union of every live registration's ports.
   */
  export function readRegistryPortExclusions(): Set<number> {
    const dir = registryPath()
    mkdirs(dir)
    const exclusions = new Set<number>()
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
          // Rehydrate through the class so allPorts stays the ONE port walker.
          const ports = getValue(() => {
            const plain = entry as BindConfig
            return new BindConfig(
              plain.kiod,
              plain.nodeop,
              plain.anvil,
              plain.solana,
              plain.debuggingServer
            ).allPorts
          }, [] as number[])
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
    daemon: string
  ): Promise<number> {
    if (callerPin !== null) {
      const resolved = await getPort({ port: callerPin, exclude: claimed })
      Assert.ok(
        resolved === callerPin,
        `port ${callerPin} for ${daemon} is pinned but unavailable`
      )
      return callerPin
    }
    return getPort(
      fallbackDefault !== null
        ? { port: fallbackDefault, exclude: claimed }
        : { exclude: claimed }
    )
  }
}
