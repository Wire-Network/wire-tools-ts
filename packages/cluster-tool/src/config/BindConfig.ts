import Assert from "node:assert"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { asOption } from "@3fv/prelude-ts"
import Bluebird from "bluebird"
import { range } from "lodash"
import type { LockOptions } from "proper-lockfile"
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
 * Drop `get-port`'s in-process port locks so a subsequent check re-probes true OS
 * bindability. Used by {@link BindConfig.validate} to re-verify the already-
 * resolved (therefore already-locked) ports.
 */
async function clearPortLocks(): Promise<void> {
  const mod = await importGetPortModule()
  mod.clearLockedPorts()
}

/**
 * The transport a resolved port will be bound with. TCP ports are fully
 * covered by `get-port`'s probe; UDP ports (the validator's gossip socket and
 * dynamic-range sockets) additionally require {@link isUdpPortFree} — see its
 * note for the failure class this closes.
 */
export enum BindConfigPortProtocol {
  tcp = "tcp",
  udp = "udp"
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

/** An inclusive contiguous port window (`first`..`last`). */
export interface BindConfigPortRange {
  first: number
  last: number
}

/**
 * solana ports — `http` is the RPC port, `faucet` the airdrop faucet.
 * `gossip` is the validator's `--gossip-port`: agave 4.x binds the test
 * validator's gossip socket at its FIXED default (8000) instead of carving it
 * from the dynamic range, so a second concurrent validator panics with
 * `gossip_addr bind_to port 8000: Address already in use` unless each cluster
 * passes its own resolved gossip port.
 * `dynamicRange` is the validator's `--dynamic-port-range` window
 * (TPU/TVU/repair sockets). Without a per-cluster window every
 * solana-test-validator carves its dynamic sockets from the SAME agave default
 * range; two concurrent validators then UDP-double-bind (the kernel allows it
 * silently) and each forwards transactions into the other's TPU, which drops
 * foreign-genesis packets — airdrops/txs return signatures that never land.
 */
export interface BindConfigSolanaPorts {
  http: number
  faucet: number
  gossip: number
  dynamicRange: BindConfigPortRange
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
  /** Pinned gossip port; must be free (TCP + UDP) or `resolve` throws. */
  gossip?: number
  /** Pinned validator dynamic-port window; every port must be free or `resolve` throws. */
  dynamicRange?: BindConfigPortRange
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
    readonly debuggingServer: BindConfigDaemon,
    /**
     * The per-resolve port window every unpinned port of this config was drawn
     * from (see {@link BindConfig.FlowPortWindowRegion}). Informational — the
     * allocation truth is the window's atomic claim file
     * ({@link BindConfig.allocateWindow}); this field rides the registry entry
     * for diagnosability. Null on configs rehydrated from the registry and on
     * configs predating window allocation.
     */
    readonly portWindow: BindConfigPortRange | null = null
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
    // only de-dupes within one process — see PortLockPath). The lock is
    // belt-and-braces: even a compromised lock cannot produce a cross-resolve
    // collision, because every resolve draws from its own disjoint window
    // (see FlowPortWindowRegion).
    return withFileLock(
      BindConfig.PortLockPath,
      () => BindConfig.resolveLocked(options, topology),
      BindConfig.PortLockOptions
    )
  }

  /** {@link resolve} body — always runs under the {@link BindConfig.PortLockPath} lock. */
  private static async resolveLocked(
    options: BindOptions,
    topology: ClusterTopologyOptions
  ): Promise<BindConfig> {
    // Claim this resolve's DISJOINT port window FIRST (atomic O_EXCL claim
    // file, independent of the advisory lock): every unpinned pick below is
    // drawn from it, so two resolves cannot collide even if the lock is
    // compromised mid-resolve (observed 2026-07-16: two concurrent CI flows
    // drew the same ephemeral port under 4-way cold-start lock contention,
    // and one cluster's nodeop died at bind). Freed when this process exits
    // (or its stale claim is reaped) — or RELEASED below when the resolve
    // fails, so a caller that catches and retries cannot burn windows toward
    // a false region-exhaustion error.
    const window = BindConfig.allocateWindow()
    try {
      return await BindConfig.resolveInWindow(options, topology, window)
    } catch (err) {
      BindConfig.releaseWindowClaim(window)
      throw err
    }
  }

  /** {@link resolveLocked} body once the window claim is held. */
  private static async resolveInWindow(
    options: BindOptions,
    topology: ClusterTopologyOptions,
    window: BindConfigPortRange
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
        daemon: string,
        protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp
      ): Promise<number> => {
        const port = await BindConfig.pickPort(
          callerPin,
          null,
          claimed,
          daemon,
          protocol,
          window
        )
        claimed.add(port)
        return port
      },
      pair = async (
        base: BindNodeopPortsOptions | null,
        daemon: string
      ): Promise<BindConfigNodeopPorts> => ({
        http: await claim(base?.http ?? null, `${daemon}.http`),
        p2p: await claim(base?.p2p ?? null, `${daemon}.p2p`)
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
      // companion. The window's LAST port is excluded from the RPC pick so the
      // companion (rpc+1) always lands inside this resolve's window too.
      claimSolanaHttp = async (): Promise<number> =>
        asOption(
          await BindConfig.pickPort(
            options.solana?.ports?.http ?? null,
            null,
            new Set([...claimed, window.last]),
            "solana.http",
            BindConfigPortProtocol.tcp,
            window
          )
        )
          .tap(http => {
            claimed.add(http)
            claimed.add(http + BindConfig.SolanaWsPortOffset)
          })
          .get(),
      // The range's ports are claimed individually so every later pick in
      // this resolve — and every other resolver via the registry — excludes
      // the whole range, not just its first port.
      claimSolanaDynamicRange = async (): Promise<BindConfigPortRange> =>
        asOption(
          await BindConfig.pickPortRange(
            options.solana?.ports?.dynamicRange ?? null,
            claimed,
            "solana.dynamicRange",
            window
          )
        )
          .tap(dynamicRange =>
            range(dynamicRange.first, dynamicRange.last + 1).forEach(port =>
              claimed.add(port)
            )
          )
          .get()

    const nodeopPorts = options.nodeop?.ports,
      producerCount = topology.producerCount ?? BindConfig.DefaultProducerCount,
      batchCount = topology.batchOperatorCount ?? BindConfig.DefaultBatchCount,
      uwCount = topology.underwriterCount ?? BindConfig.DefaultUnderwriterCount

    const resolved = new BindConfig(
      {
        address: addr("kiod"),
        port: await claim(options.kiod?.port ?? null, "kiod")
      },
      {
        address: addr("nodeop"),
        ports: {
          bios: {
            http: await claim(
              nodeopPorts?.bios?.http ?? null,
              "nodeop.bios.http"
            ),
            p2p: await claim(nodeopPorts?.bios?.p2p ?? null, "nodeop.bios.p2p")
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
      {
        address: addr("anvil"),
        port: await claim(options.anvil?.port ?? null, "anvil")
      },
      {
        address: addr("solana"),
        ports: {
          http: await claimSolanaHttp(),
          faucet: await claim(
            options.solana?.ports?.faucet ?? null,
            "solana.faucet"
          ),
          // agave 4.x binds the test validator's gossip socket at its FIXED
          // default (8000) instead of carving it from --dynamic-port-range,
          // so every parallel validator needs an explicit per-cluster
          // --gossip-port. Cross-cluster disjointness comes from the same
          // machinery as every other port: the pick is drawn from this
          // resolve's own window, so no two clusters ever resolve the same
          // gossip port. Gossip is a UDP socket — the claim additionally
          // UDP-probes candidates, catching non-registry UDP holders that
          // get-port's TCP probe cannot see.
          gossip: await claim(
            options.solana?.ports?.gossip ?? null,
            "solana.gossip",
            BindConfigPortProtocol.udp
          ),
          dynamicRange: await claimSolanaDynamicRange()
        }
      },
      {
        address: addr("debuggingServer"),
        port: await claim(
          options.debuggingServer?.port ?? null,
          "debuggingServer"
        )
      },
      window
    )
    // Register BEFORE the lock releases: the next resolver (any process) must
    // see these ports — and this resolve's window claim — as reserved even
    // though no daemon has bound them yet.
    BindConfig.registerResolved(resolved)
    return resolved
  }

  /** Flat list of every port, for validation. */
  get allPorts(): number[] {
    const np = this.nodeop.ports,
      flat = (xs: BindConfigNodeopPorts[]) => xs.flatMap(p => [p.http, p.p2p]),
      dynamicRange = this.solana.ports.dynamicRange
    return [
      this.kiod.port,
      np.bios.http,
      np.bios.p2p,
      ...flat(np.producers),
      ...flat(np.batch),
      ...flat(np.underwriters),
      this.anvil.port,
      this.solana.ports.http,
      // The RPC's companion websocket — agave binds rpc+1 automatically (no
      // flag assigns it); it rides allPorts so the registry excludes it for
      // every other resolver.
      this.solana.ports.http + BindConfig.SolanaWsPortOffset,
      this.solana.ports.faucet,
      this.solana.ports.gossip,
      ...range(dynamicRange.first, dynamicRange.last + 1),
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
   * (parallel `flow-*` / `wire-cluster-tool` runs). `get-port` only de-dupes
   * within one process; this cross-process advisory lock (via `withFileLock`)
   * stops two processes racing the same free port while finding it. Shared by
   * ALL processes on the host, so it lives under the OS temp dir, not a cluster
   * path.
   */
  export const PortLockPath = Path.join(Os.tmpdir(), "wire-cluster-ports.lock")
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
  // see {@link BindConfig.allPorts}).
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
   * {@link BindConfig.allPorts}).
   */
  export const SolanaWsPortOffset = 1
  /**
   * Preferred validator gossip port — outside {@link ReservedAgavePortBand}
   * like every other default; gossip is UDP, so its claim additionally
   * UDP-probes candidates (see {@link BindConfigPortProtocol}).
   */
  export const DefaultSolanaGossip = 11_000
  /**
   * Bounded redraws when resolving a UDP-role port: candidates that pass the
   * TCP probe but fail the UDP probe are excluded and redrawn up to this many
   * times before the resolve fails loudly. Raising it only matters on a host
   * whose UDP space is heavily squatted.
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
  export const DefaultProducerCount = 1
  export const DefaultBatchCount = 3
  export const DefaultUnderwriterCount = 1

  /**
   * Host region carved into per-resolve port windows. Every unpinned port of a
   * resolve — nodeop http/p2p, kiod, anvil, solana rpc/ws/faucet/gossip, the
   * validator dynamic range, the debugging server — is drawn from the resolve's
   * OWN window, so two resolves cannot collide even if the advisory port lock is
   * compromised (observed 2026-07-16: 4-way CI cold-start contention let two
   * flows resolve concurrently and draw the same ephemeral port; one cluster's
   * nodeop died at bind with `Address already in use`). The region sits above
   * the daemon-default (10500-11999) and legacy dynamic-range (12000+) bands and
   * BELOW the kernel's ephemeral floor (32768 on CI runners), so an outbound
   * connection's kernel-assigned source port can never squat a window port.
   */
  export const FlowPortWindowRegion: BindConfigPortRange = {
    first: 16_384,
    last: 28_671
  }

  /**
   * Width of one per-resolve window. The largest cluster footprint (a dozen
   * nodeop pairs, the singleton daemons, the RPC websocket companion, and a
   * {@link SolanaDynamicPortRangeSize}-port validator range) is ~110 ports;
   * 512 leaves generous slack for in-window squatters and future daemons while
   * still yielding 24 windows — far beyond any realistic flow concurrency.
   */
  export const FlowPortWindowWidth = 512

  /**
   * proper-lockfile options for the host-global port lock. The default backoff
   * (5 retries, ~3s total) can be exhausted while several cold-starting flows
   * queue behind one multi-second resolve; fixed-interval retries wait out a
   * deep queue. A compromised (stale-stolen) lock is LOGGED loudly instead of
   * proper-lockfile's asynchronous throw: window claims are ATOMIC O_EXCL
   * claim files ({@link allocateWindow}), taken BEFORE any pick, so a thief
   * resolver cannot double-allocate a window — the two resolves proceed in
   * disjoint windows and the compromise is noise, not a collision. (The
   * holder's eventual release() rejects with ERELEASED after a compromise;
   * `withFileLock` swallows release failures for the same reason.)
   */
  export const PortLockOptions: LockOptions = {
    realpath: false,
    retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 },
    stale: 10_000,
    onCompromised: err =>
      log.error(
        "port lock compromised (stale-stolen mid-resolve) — window claims are atomic, continuing",
        err
      )
  }

  /**
   * Lock options for the STANDALONE pickers ({@link findAvailable} /
   * {@link findAvailableRange}): same contention-hardened retries as
   * {@link PortLockOptions}, but a compromised lock stays FAIL-CLOSED
   * (proper-lockfile's default onCompromised throws). Unlike {@link resolve},
   * these paths hold no atomic window claim — their cross-process safety IS
   * the lock — so continuing after a steal could hand two processes the same
   * preferred port or range.
   */
  export const StandalonePortLockOptions: LockOptions = {
    realpath: false,
    retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 },
    stale: 10_000
  }

  /** Claim-file path for the window starting at `first` (content: claimant pid). */
  function windowClaimFile(first: number): string {
    return Path.join(registryPath(), `window-${first}.claim`)
  }

  /** Window claim files THIS process created — released together on exit. */
  const ownedWindowClaims: string[] = []
  let windowClaimExitCleanupArmed = false

  /**
   * Claim the lowest free window in {@link FlowPortWindowRegion} via an ATOMIC
   * exclusive-create (`wx`) claim file per window — deliberately independent of
   * the advisory port lock, so even a compromised lock cannot hand two resolves
   * the same window: the filesystem arbitrates. A stale claim (dead pid,
   * recycled pid, unreadable content) is reaped exactly like a stale registry
   * file; a claim frees when its process exits (exit hook) or is reaped.
   * {@link resolve} calls this under the {@link BindConfig.PortLockPath} lock,
   * but correctness does not depend on it.
   *
   * @returns The claimed window.
   * @throws When every window in the region is claimed by a live process.
   */
  export function allocateWindow(): BindConfigPortRange {
    mkdirs(registryPath())
    const count = Math.floor(
      (FlowPortWindowRegion.last - FlowPortWindowRegion.first + 1) /
        FlowPortWindowWidth
    )
    for (const index of range(count)) {
      const first = FlowPortWindowRegion.first + index * FlowPortWindowWidth
      const file = windowClaimFile(first)
      const content = getValue(() => Fs.readFileSync(file, "utf8"), null)
      if (content !== null) {
        const pid = Number.parseInt(content, 10)
        const basename = Number.isFinite(pid)
            ? processCommandBasename(pid)
            : "",
          alive = Number.isFinite(pid) && isPidAlive(pid),
          // "" basename + alive = unreadable /proc (foreign user) → keep.
          recycled = alive && basename !== "" && basename !== RegistrantBasename
        if (alive && !recycled) {
          continue
        }
        log.info(
          `bind registry: reaping stale window claim ${Path.basename(file)} ` +
            `(${!alive ? "pid gone" : `pid recycled to ${basename}`})`
        )
        guard(() => Fs.rmSync(file, { force: true }))
      }
      try {
        // O_EXCL: exactly one process can create the claim, lock or no lock.
        Fs.writeFileSync(file, String(process.pid), { flag: "wx" })
      } catch {
        continue // lost the create race (or a claim reappeared) — next window
      }
      ownedWindowClaims.push(file)
      if (!windowClaimExitCleanupArmed) {
        windowClaimExitCleanupArmed = true
        process.on("exit", () =>
          ownedWindowClaims.forEach(claim =>
            guard(() => Fs.rmSync(claim, { force: true }))
          )
        )
      }
      return { first, last: first + FlowPortWindowWidth - 1 }
    }
    return Assert.fail(
      `all ${count} port windows in ${FlowPortWindowRegion.first}-${FlowPortWindowRegion.last} ` +
        `are claimed by live resolves — lower the flow concurrency or widen FlowPortWindowRegion`
    )
  }

  /**
   * Release a window claim this process holds — the failure path of
   * {@link BindConfig.resolve}: a resolve that throws after allocation (a
   * pinned-but-unavailable port, an unusable dynamic range, a registry write
   * error) must hand its window back immediately rather than hold it until
   * process exit, or a caller that catches and retries burns windows toward a
   * false region-exhaustion error. Releasing a window this process does not
   * own is a no-op.
   *
   * @param window - The window returned by {@link allocateWindow}.
   */
  export function releaseWindowClaim(window: BindConfigPortRange): void {
    const file = windowClaimFile(window.first)
    const index = ownedWindowClaims.indexOf(file)
    if (index < 0) {
      return
    }
    ownedWindowClaims.splice(index, 1)
    guard(() => Fs.rmSync(file, { force: true }))
  }

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
   * @param protocol - Transport the port will be bound with; UDP-role ports
   *   (validator gossip) are additionally UDP-probed.
   * @returns A currently-free port (the preferred one when possible).
   */
  export async function findAvailable(
    preferred: number,
    protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp
  ): Promise<number> {
    return withFileLock(
      BindConfig.PortLockPath,
      () =>
        pickPort(
          null,
          preferred,
          readRegistryPortExclusions(),
          "findAvailable",
          protocol
        ),
      BindConfig.StandalonePortLockOptions
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
   * is kept conservatively. Call only under the {@link BindConfig.PortLockPath}
   * lock — read/reap/resolve/write must be one critical section.
   *
   * The set is SEEDED with {@link ReservedAgavePortBand} — the band is a
   * standing registration on behalf of every validator's implicit binds, so
   * no picker downstream of this read can ever assign inside it.
   *
   * @returns The union of the reserved band and every live registration's ports.
   */
  /**
   * Every LIVE registration's raw entries, reaping stale files as they are
   * found (see {@link readRegistryPortExclusions} for the reaping rules). The
   * shared walk behind the port-exclusion and window-claim readers. Call only
   * under the {@link BindConfig.PortLockPath} lock.
   *
   * @returns The raw (plain-JSON) entries of every live registration.
   */
  function readLiveRegistryEntries(): unknown[] {
    const dir = registryPath()
    mkdirs(dir)
    const live: unknown[] = []
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
        entries.forEach(entry => live.push(entry))
      })
    return live
  }

  export function readRegistryPortExclusions(): Set<number> {
    const exclusions = new Set<number>(
      range(ReservedAgavePortBand.first, ReservedAgavePortBand.last + 1)
    )
    readLiveRegistryEntries().forEach(entry => {
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
        log.warn("bind registry: ignoring malformed entry")
      }
      ports.forEach(port => exclusions.add(port))
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
    daemon: string,
    protocol: BindConfigPortProtocol = BindConfigPortProtocol.tcp,
    window: BindConfigPortRange | null = null
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
    // Windowed draws scan the window in order (lowest free first — get-port
    // tries iterable preferences sequentially), so a resolve's layout is
    // deterministic per window slot; unwindowed draws prefer the default on
    // the first attempt. A UDP-role candidate that fails the UDP probe is
    // redrawn — the rejected candidate stays locked in get-port's in-process
    // cache, so no later draw can re-offer it.
    const picked = await Bluebird.reduce(
      range(0, UdpPickAttempts),
      async (found: number | null, attempt: number) => {
        if (found !== null) return found
        const candidate = await getPort(
          window !== null
            ? { port: range(window.first, window.last + 1), exclude: claimed }
            : attempt === 0 && fallbackDefault !== null
              ? { port: fallbackDefault, exclude: claimed }
              : { exclude: claimed }
        )
        // get-port falls back to an OS-assigned ephemeral when every
        // preference is unavailable — for a windowed draw that silent escape
        // would defeat cross-resolve disjointness, so it is a hard error.
        Assert.ok(
          window === null ||
            (candidate >= window.first && candidate <= window.last),
          `${daemon}: port window ${window?.first}-${window?.last} is exhausted ` +
            `(get-port fell back to ${candidate}) — foreign listeners inside the ` +
            `window, or FlowPortWindowWidth is too small for this topology`
        )
        return protocol === BindConfigPortProtocol.tcp ||
          (await isUdpPortFree(candidate))
          ? candidate
          : null
      },
      null as number | null
    )
    Assert.ok(
      picked !== null,
      `no UDP-bindable port found for ${daemon} within ${UdpPickAttempts} attempts`
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
   * {@link BindConfig.PortLockPath} lock (resolve does).
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
    daemon: string,
    window: BindConfigPortRange | null = null
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
    // Windowed scans carve the range from the resolve's own window
    // (SolanaDynamicPortRangeSize-aligned offsets) so the validator's dynamic
    // sockets stay inside the resolve's disjoint footprint; unwindowed scans
    // (findAvailableRange) keep the legacy region.
    const starts =
      window !== null
        ? range(
            0,
            Math.floor(
              (window.last - window.first + 1) / SolanaDynamicPortRangeSize
            )
          ).map(i => window.first + i * SolanaDynamicPortRangeSize)
        : range(0, SolanaDynamicPortRangeSearchLimit).map(
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
      window !== null
        ? `no free ${SolanaDynamicPortRangeSize}-port range for ${daemon} inside window ` +
            `${window.first}-${window.last} — foreign listeners inside the window, or ` +
            `FlowPortWindowWidth is too small for this topology`
        : `no free ${SolanaDynamicPortRangeSize}-port window for ${daemon} within ` +
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
    return withFileLock(
      BindConfig.PortLockPath,
      () =>
        pickPortRange(
          null,
          readRegistryPortExclusions(),
          "solana.dynamicRange"
        ),
      BindConfig.StandalonePortLockOptions
    )
  }
}
