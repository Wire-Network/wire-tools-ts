import { jest } from "@jest/globals"
import { spawn, spawnSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { Deferred, guard } from "@wireio/shared"
// Leaf import (not the processes barrel): the barrel pulls NodeopProcess →
// WireClient → @wireio/sdk-core into this config-only suite's module graph.
import { ProcessSignalName } from "@wireio/cluster-tool/cluster/processes/ProcessSignals"

/**
 * Options the fake `get-port` honors — the subset {@link BindConfig} passes
 * (`port` preference + `exclude` set). Named (not inline) per repo style.
 */
interface FakeGetPortOptions {
  port?: number | Iterable<number>
  exclude?: Iterable<number>
}

/** Ephemeral ports the fake hands out start here — well clear of every default. */
const FakeEphemeralBase = 50000

/**
 * Deterministic in-memory model of `get-port`, so port outcomes are driven by
 * the test rather than whatever real host ports happen to be free while other
 * suites run in parallel (the whole point — see the bind-available-ports rule).
 *
 * Faithful to the behaviors {@link BindConfig} relies on:
 * - a preferred `port` (a single number or, as real `get-port` accepts, an
 *   ITERABLE tried in order — the windowed-draw path) yields the first free
 *   preference; when every preference is unavailable a fresh ephemeral is
 *   returned (the fallback BindConfig's windowed draws must detect),
 * - every returned port is LOCKED in-process, so consecutive calls never repeat
 *   — the same collision-avoidance real `get-port` provides. {@link clearLocks}
 *   drops those locks (what {@link BindConfig.validate} does before re-probing).
 *
 * `taken` is the test-controlled "occupied by the OS / another process" set:
 * marking a port taken makes it un-bindable exactly as a live listener would.
 */
class FakePortAllocator {
  /** Simulated OS-occupied ports — test-controlled via {@link markTaken}. */
  readonly taken = new Set<number>()
  /** get-port's in-process locks on already-handed-out ports. */
  readonly locked = new Set<number>()
  private cursor = FakeEphemeralBase

  /** Reset all state between tests (fresh taken/locked sets, ephemeral cursor). */
  reset(): void {
    this.taken.clear()
    this.locked.clear()
    this.cursor = FakeEphemeralBase
  }

  /**
   * Mark ports as occupied so a preference for them falls back to an ephemeral.
   *
   * @param ports - Ports to treat as un-bindable.
   */
  markTaken(...ports: number[]): void {
    ports.forEach(port => this.taken.add(port))
  }

  /** Drop the in-process locks (models `get-port`'s `clearLockedPorts`). */
  clearLocks(): void {
    this.locked.clear()
  }

  /**
   * Resolve a port the way `get-port` would: the preferred `port` when free,
   * else the next free ephemeral. The chosen port is locked before returning.
   *
   * @param options - Preferred `port` and/or an `exclude` set.
   * @returns The resolved (and now-locked) port.
   */
  allocate(options?: FakeGetPortOptions): number {
    const blocked = new Set<number>([
      ...this.taken,
      ...this.locked,
      ...(options?.exclude ?? [])
    ])
    const preferences =
      options?.port === undefined
        ? []
        : typeof options.port === "number"
          ? [options.port]
          : [...options.port]
    const chosen =
      preferences.find(preference => !blocked.has(preference)) ??
      this.nextEphemeral(blocked)
    this.locked.add(chosen)
    return chosen
  }

  /** Next ephemeral above the cursor that is not currently blocked. */
  private nextEphemeral(blocked: Set<number>): number {
    this.cursor += 1
    return blocked.has(this.cursor) ? this.nextEphemeral(blocked) : this.cursor
  }
}

const allocator = new FakePortAllocator()

// Intercept the ESM-only `get-port` that BindConfig dynamically imports. Plain
// `jest.mock` does NOT intercept the preserved native `import()` (verified); the
// unstable ESM-module mock does. Every port-finding path (findAvailable /
// pickPort / isPortAvailable) routes through this one fake, so the fake's state
// deterministically decides every outcome.
jest.unstable_mockModule("get-port", () => ({
  __esModule: true,
  default: jest.fn(async (options?: FakeGetPortOptions) =>
    allocator.allocate(options)
  ),
  clearLockedPorts: jest.fn(() => allocator.clearLocks())
}))

/**
 * Test-controlled "UDP-held by a non-registry process" set. The real
 * `isUdpPortFree` binds actual OS sockets — deterministic outcomes here
 * require faking it exactly like `get-port` above (otherwise a live validator
 * on the host would steer which dynamic-range window these tests resolve).
 */
const mockUdpTakenPorts = new Set<number>()
jest.mock("@wireio/cluster-tool/utils/netUtils", () => ({
  ...(jest.requireActual(
    "@wireio/cluster-tool/utils/netUtils"
  ) as typeof import("@wireio/cluster-tool/utils/netUtils")),
  isUdpPortFree: jest.fn(async (port: number) => !mockUdpTakenPorts.has(port))
}))

describe("BindConfig", () => {
  // Import AFTER the mock is registered so BindConfig's cached get-port is the
  // fake. A static top-level import would load the real module first.
  let BindConfig: typeof import("@wireio/cluster-tool/config/BindConfig").BindConfig

  beforeAll(async () => {
    // Leaf import (not the config barrel): the barrel pulls NodeConfig →
    // WireClient → @wireio/sdk-core into this suite's module graph.
    ;({ BindConfig } = await import("@wireio/cluster-tool/config/BindConfig"))
  })

  beforeEach(() => {
    allocator.reset()
    mockUdpTakenPorts.clear()
    // Fresh registry per test — resolve() registers its ports, and a leftover
    // registration would leak exclusions into the next test's outcome. The
    // scratch dir itself is installed by tests/jest.setup.ts.
    Fs.rmSync(BindConfig.registryPath(), { recursive: true, force: true })
  })

  describe("resolve", () => {
    it("draws every unpinned port from the first free window, lowest-first", async () => {
      const config = await BindConfig.resolve({}, {})
      // Nothing taken → the resolve claims window 0 and fills it from the base
      // (get-port tries the window's ports in order), so the first pick IS the
      // window base and every port — including the RPC websocket companion —
      // lands inside the claimed window. Daemon DEFAULTS are deliberately not
      // preferred: a default-preferring pick is exactly the cross-resolve
      // collision surface windows exist to remove.
      expect(config.portWindow).toEqual({
        first: BindConfig.FlowPortWindowRegion.first,
        last:
          BindConfig.FlowPortWindowRegion.first +
          BindConfig.FlowPortWindowWidth -
          1
      })
      expect(config.kiod.port).toBe(config.portWindow!.first)
      const { first, last } = config.portWindow!
      config.allPorts.forEach(port => {
        expect(port).toBeGreaterThanOrEqual(first)
        expect(port).toBeLessThanOrEqual(last)
      })
    })

    it("skips a squatted in-window port without leaving the window", async () => {
      const windowFirst = BindConfig.FlowPortWindowRegion.first
      // Squat the window base and the third slot; picks flow around them.
      allocator.markTaken(windowFirst, windowFirst + 2)
      const config = await BindConfig.resolve({}, {})
      expect(config.kiod.port).toBe(windowFirst + 1)
      expect(config.nodeop.ports.bios.http).toBe(windowFirst + 3)
      const { first, last } = config.portWindow!
      config.allPorts.forEach(port => {
        expect(port).toBeGreaterThanOrEqual(first)
        expect(port).toBeLessThanOrEqual(last)
      })
    })

    it("populates every daemon with addresses + unique ports", async () => {
      const config = await BindConfig.resolve(
        {},
        { producerCount: 2, batchOperatorCount: 3, underwriterCount: 1 }
      )
      expect(config.kiod.address).toBe(BindConfig.LoopbackAddress)
      expect(config.nodeop.ports.producers).toHaveLength(2)
      expect(config.nodeop.ports.batch).toHaveLength(3)
      expect(config.nodeop.ports.underwriters).toHaveLength(1)
      const ports = config.allPorts
      expect(new Set(ports).size).toBe(ports.length)
      expect(ports.every(port => port > 0)).toBe(true)
    })

    it("binds every address to the bind-all address when bindAll is set", async () => {
      const config = await BindConfig.resolve({}, { bindAll: true })
      expect(config.kiod.address).toBe(BindConfig.BindAllAddress)
      expect(config.nodeop.address).toBe(BindConfig.BindAllAddress)
      expect(config.anvil.address).toBe(BindConfig.BindAllAddress)
      expect(config.solana.address).toBe(BindConfig.BindAllAddress)
      expect(config.debuggingServer.address).toBe(BindConfig.BindAllAddress)
    })

    it("honors a per-daemon address override", async () => {
      const config = await BindConfig.resolve(
        { anvil: { address: BindConfig.BindAllAddress } },
        {}
      )
      // bindAll is NOT set, so the default would be loopback — the override wins.
      expect(config.anvil.address).toBe(BindConfig.BindAllAddress)
      expect(config.kiod.address).toBe(BindConfig.LoopbackAddress)
    })

    it("throws when a pinned port is unavailable", async () => {
      const pinned = 7777
      allocator.markTaken(pinned)
      await expect(
        BindConfig.resolve({ kiod: { port: pinned } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("uses a caller-pinned port when it is free", async () => {
      const pinned = 7777
      const config = await BindConfig.resolve({ kiod: { port: pinned } }, {})
      expect(config.kiod.port).toBe(pinned)
    })
  })

  describe("isPortAvailable", () => {
    it("is false for a taken port and true for a free one", async () => {
      const port = 6543
      allocator.markTaken(port)
      expect(await BindConfig.isPortAvailable(port)).toBe(false)
      allocator.reset()
      expect(await BindConfig.isPortAvailable(port)).toBe(true)
    })
  })

  describe("validate", () => {
    it("is true when every resolved port is free", async () => {
      const config = await BindConfig.resolve({}, {})
      expect(await config.validate()).toBe(true)
    })

    it("is false once a resolved port becomes taken", async () => {
      const config = await BindConfig.resolve({}, {})
      // A port that was free at resolve is now occupied — validate must catch it.
      allocator.markTaken(config.anvil.port)
      expect(await config.validate()).toBe(false)
    })
  })

  describe("solana dynamic port range", () => {
    it("resolves an aligned, full-width range inside the resolve's window", async () => {
      const config = await BindConfig.resolve({}, {})
      const { first, last } = config.solana.ports.dynamicRange
      expect(last - first + 1).toBe(BindConfig.SolanaDynamicPortRangeSize)
      // Carved from the resolve's own window at range-size-aligned offsets.
      expect(first).toBeGreaterThanOrEqual(config.portWindow!.first)
      expect(last).toBeLessThanOrEqual(config.portWindow!.last)
      expect(
        (first - config.portWindow!.first) %
          BindConfig.SolanaDynamicPortRangeSize
      ).toBe(0)
      expect(config.allPorts).toEqual(expect.arrayContaining([first, last]))
    })

    it("two resolves claim DISJOINT windows (the co-running-validator guarantee)", async () => {
      const first = await BindConfig.resolve({}, {})
      const second = await BindConfig.resolve({}, {})
      const a = first.solana.ports.dynamicRange
      const b = second.solana.ports.dynamicRange
      const overlaps = a.first <= b.last && b.first <= a.last
      expect(overlaps).toBe(false)
    })

    it("uses a caller-pinned window when it is free", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfig.SolanaDynamicPortRangeSize - 1
      }
      const config = await BindConfig.resolve(
        { solana: { ports: { dynamicRange: pinned } } },
        {}
      )
      expect(config.solana.ports.dynamicRange).toEqual(pinned)
    })

    it("throws when a pinned window is unavailable", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfig.SolanaDynamicPortRangeSize - 1
      }
      // One occupied port anywhere in the window poisons the whole pin.
      allocator.markTaken(13_007)
      await expect(
        BindConfig.resolve({ solana: { ports: { dynamicRange: pinned } } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("uses a caller-pinned gossip port when it is free", async () => {
      const pinned = 14_500
      const config = await BindConfig.resolve(
        { solana: { ports: { gossip: pinned } } },
        {}
      )
      expect(config.solana.ports.gossip).toBe(pinned)
    })

    it("throws when a pinned gossip port is taken (same pin semantics as every daemon)", async () => {
      const pinned = 14_600
      allocator.markTaken(pinned)
      await expect(
        BindConfig.resolve({ solana: { ports: { gossip: pinned } } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("findAvailableRange returns a full-width window without registering", async () => {
      const window = await BindConfig.findAvailableRange()
      expect(window.last - window.first + 1).toBe(
        BindConfig.SolanaDynamicPortRangeSize
      )
      // reading never registers THIS process (mirrors findAvailable)
      expect(Fs.existsSync(BindConfig.registryFile())).toBe(false)
    })
  })

  // agave binds implicit sockets first-free from its built-in 8000-10000
  // range regardless of --gossip-port/--dynamic-port-range, so the band is a
  // standing registration: NOTHING the harness assigns may sit inside it —
  // not a default, not an ephemeral fallback, not a caller pin, not a window.
  describe("reserved agave band (8000-10000 is never assigned)", () => {
    it("every default preference and the window base sit OUTSIDE the band (and clear of the solana ws companion rpc+1)", () => {
      const band = BindConfig.ReservedAgavePortBand
      const defaults = [
        BindConfig.DefaultKiod,
        BindConfig.DefaultBiosHttp,
        BindConfig.DefaultBiosP2p,
        BindConfig.DefaultAnvil,
        BindConfig.DefaultSolanaRpc,
        BindConfig.DefaultSolanaFaucet,
        BindConfig.DefaultSolanaGossip,
        BindConfig.DefaultDebuggingServer,
        BindConfig.DefaultSolanaDynamicPortFirst
      ]
      defaults.forEach(port =>
        expect(port < band.first || port > band.last).toBe(true)
      )
      // rpc+1 is agave's automatic websocket port — no default may collide.
      expect(defaults).not.toContain(BindConfig.DefaultSolanaRpc + 1)
    })

    it("findAvailable never returns an in-band port even when preferred and OS-free", async () => {
      const inBand = 8899
      const port = await BindConfig.findAvailable(inBand)
      expect(port).not.toBe(inBand)
      expect(
        port < BindConfig.ReservedAgavePortBand.first ||
          port > BindConfig.ReservedAgavePortBand.last
      ).toBe(true)
    })

    it("throws on a caller pin inside the band, naming the band", async () => {
      await expect(
        BindConfig.resolve({ solana: { ports: { http: 8899 } } }, {})
      ).rejects.toThrow(/reserved agave validator band 8000-10000/)
    })

    it("throws on a pinned window overlapping the band, naming the band", async () => {
      const pinned = {
        first: 9_990,
        last: 9_990 + BindConfig.SolanaDynamicPortRangeSize - 1
      }
      await expect(
        BindConfig.resolve({ solana: { ports: { dynamicRange: pinned } } }, {})
      ).rejects.toThrow(/reserved agave validator band 8000-10000/)
    })

    it("resolve produces NO in-band port and claims the solana ws companion (rpc+1)", async () => {
      const config = await BindConfig.resolve({}, {})
      const band = BindConfig.ReservedAgavePortBand
      config.allPorts.forEach(port =>
        expect(port < band.first || port > band.last).toBe(true)
      )
      expect(config.allPorts).toContain(config.solana.ports.http + 1)
    })
  })

  // A UDP-only holder passes every TCP probe (get-port) while still panicking
  // agave at first bind — the 2026-07-15 gate failure class. UDP-role ports
  // (gossip, dynamic range) must consult the UDP probe; TCP-role ports must
  // not change behavior.
  describe("UDP-role ports (non-registry UDP holders)", () => {
    it("gossip redraws past a UDP-held in-window candidate (TCP probe passes)", async () => {
      // Learn where gossip lands on a clean resolve, then UDP-hold exactly that
      // port: the layout is deterministic (lowest-free-in-window), so the same
      // slot is offered first on the re-run and must be redrawn past.
      const clean = await BindConfig.resolve({}, {})
      const cleanGossip = clean.solana.ports.gossip
      allocator.reset()
      Fs.rmSync(BindConfig.registryPath(), { recursive: true, force: true })
      mockUdpTakenPorts.add(cleanGossip)
      const config = await BindConfig.resolve({}, {})
      expect(config.solana.ports.gossip).not.toBe(cleanGossip)
      expect(mockUdpTakenPorts.has(config.solana.ports.gossip)).toBe(false)
      // The redrawn gossip port stays inside the resolve's window, and the
      // TCP-role picks are untouched by the UDP holder.
      expect(config.solana.ports.gossip).toBeGreaterThanOrEqual(
        config.portWindow!.first
      )
      expect(config.solana.ports.gossip).toBeLessThanOrEqual(
        config.portWindow!.last
      )
      expect(config.solana.ports.http).toBe(clean.solana.ports.http)
    })

    it("throws when a pinned gossip port is UDP-held", async () => {
      const pinned = 14_700
      mockUdpTakenPorts.add(pinned)
      await expect(
        BindConfig.resolve({ solana: { ports: { gossip: pinned } } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("dynamic range skips an aligned slot containing a UDP-held port", async () => {
      // Learn the clean slot, UDP-hold a port inside it, and expect the next
      // range-size-aligned slot within the same window.
      const clean = await BindConfig.resolve({}, {})
      const cleanFirst = clean.solana.ports.dynamicRange.first
      allocator.reset()
      Fs.rmSync(BindConfig.registryPath(), { recursive: true, force: true })
      mockUdpTakenPorts.add(cleanFirst + 5)
      const config = await BindConfig.resolve({}, {})
      expect(config.solana.ports.dynamicRange.first).toBe(
        cleanFirst + BindConfig.SolanaDynamicPortRangeSize
      )
      expect(config.solana.ports.dynamicRange.last).toBeLessThanOrEqual(
        config.portWindow!.last
      )
    })

    it("throws when a pinned window contains a UDP-held port", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfig.SolanaDynamicPortRangeSize - 1
      }
      mockUdpTakenPorts.add(13_042)
      await expect(
        BindConfig.resolve({ solana: { ports: { dynamicRange: pinned } } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("findAvailable redraws past a UDP-held preferred port only under the udp protocol", async () => {
      // Leaf import — the config barrel drags @wireio/sdk-core in (see beforeAll).
      const { BindConfigPortProtocol } =
        await import("@wireio/cluster-tool/config/BindConfig")
      const preferred = 14_800
      mockUdpTakenPorts.add(preferred)
      // tcp (default): the UDP holder is irrelevant — preferred wins.
      expect(await BindConfig.findAvailable(preferred)).toBe(preferred)
      allocator.clearLocks()
      // udp: the holder forces a redraw to a UDP-free ephemeral.
      const port = await BindConfig.findAvailable(
        preferred,
        BindConfigPortProtocol.udp
      )
      expect(port).not.toBe(preferred)
      expect(mockUdpTakenPorts.has(port)).toBe(false)
    })
  })

  describe("findAvailable", () => {
    it("returns the preferred port when it is free", async () => {
      expect(await BindConfig.findAvailable(BindConfig.DefaultAnvil)).toBe(
        BindConfig.DefaultAnvil
      )
    })

    it("returns a different free port when the preferred is taken", async () => {
      allocator.markTaken(BindConfig.DefaultAnvil)
      const port = await BindConfig.findAvailable(BindConfig.DefaultAnvil)
      expect(port).not.toBe(BindConfig.DefaultAnvil)
      expect(port).toBeGreaterThan(0)
    })
  })

  describe("cross-process registry", () => {
    /**
     * A minimal resolved BindConfig whose only interesting claim is `port`
     * (plus, optionally, a window claim — omitted models a legacy pre-window
     * registration, which claims PORTS but no window).
     */
    function configClaiming(
      port: number,
      portWindow: { first: number; last: number } | null = null
    ) {
      return new BindConfig(
        { address: BindConfig.LoopbackAddress, port },
        {
          address: BindConfig.LoopbackAddress,
          ports: {
            bios: { http: port + 1, p2p: port + 2 },
            producers: [],
            batch: [],
            underwriters: []
          }
        },
        { address: BindConfig.LoopbackAddress, port: port + 3 },
        {
          address: BindConfig.LoopbackAddress,
          ports: {
            http: port + 4,
            faucet: port + 5,
            gossip: port + 8,
            // Width-1 window keeps the claim minimal (one extra port).
            dynamicRange: { first: port + 7, last: port + 7 }
          }
        },
        { address: BindConfig.LoopbackAddress, port: port + 6 },
        portWindow
      )
    }

    /** Write a registry file for `pid` claiming `config`'s ports. */
    function seedRegistration(
      pid: number,
      config: InstanceType<typeof BindConfig>
    ): string {
      Fs.mkdirSync(BindConfig.registryPath(), { recursive: true })
      const file = Path.join(
        BindConfig.registryPath(),
        `${pid}${BindConfig.RegistryFileSuffix}`
      )
      Fs.writeFileSync(file, JSON.stringify([config]))
      return file
    }

    /**
     * A LIVE registrant pid with a guaranteed `node` command basename. The
     * registry's recycled-pid guard honors only live `node` pids, and
     * `process.ppid` is NOT reliably one — under wrapper chains (npx → sh,
     * `--detectOpenHandles` in-band) the parent is a shell and the guard
     * reaps the seeded registration, failing the live-registrant tests.
     */
    let registrant: ReturnType<typeof spawn>
    beforeAll(() => {
      // The child blocks on its stdin pipe, so it lives EXACTLY as long as
      // this worker: afterAll kills it on the normal path, and if the worker
      // dies any other way the pipe EOF drains its event loop and it exits on
      // its own — no idle-timer lifetime to race the suite, no orphan window.
      // Deliberately NOT unref'd: if the reap below ever fails, jest must
      // report the leaked handle, not hide it.
      registrant = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"]
      })
      expect(registrant.pid).toBeGreaterThan(0)
    })
    afterAll(async () => {
      // Await "close" (exit + stdio teardown), not "exit": the stdin pipe
      // socket and the child handle must be FULLY gone before the worker
      // tears down, or their closing races jest's exit grace (the
      // intermittent "worker failed to exit gracefully" warning).
      const closed = Deferred.useCallback<void>(deferred => {
        if (registrant.exitCode != null || registrant.signalCode != null) {
          deferred.resolve()
          return
        }
        registrant.once("close", () => deferred.resolve())
      }).promise
      registrant.stdin.destroy()
      // Best-effort signal — ESRCH if the child already exited.
      guard(() => process.kill(registrant.pid, ProcessSignalName.SIGKILL))
      await closed
    })

    it("registryPath honors the env override (installed by jest.setup)", () => {
      expect(BindConfig.registryPath()).toBe(
        process.env.WIRE_BIND_REGISTRY_PATH
      )
    })

    it("resolve registers its ports in this process's file, appending per resolve", async () => {
      const first = await BindConfig.resolve({}, {})
      const second = await BindConfig.resolve({}, {})
      const entries = JSON.parse(
        Fs.readFileSync(BindConfig.registryFile(), "utf8")
      )
      expect(Array.isArray(entries)).toBe(true)
      expect(entries).toHaveLength(2)
      expect(entries[0].kiod.port).toBe(first.kiod.port)
      expect(entries[1].kiod.port).toBe(second.kiod.port)
      // The second resolve read the first's registration — zero overlap.
      const overlap = first.allPorts.filter(port =>
        second.allPorts.includes(port)
      )
      expect(overlap).toEqual([])
    })

    it("resolve excludes a LIVE foreign registration's ports", async () => {
      // The foreign claim sits at the base of window 0 — exactly where this
      // resolve's lowest-first picks would land — so the exclusion is
      // observable: the picks flow around the claimed ports while staying in
      // the window (a legacy entry without a portWindow claims PORTS only,
      // not the window itself).
      const base = BindConfig.FlowPortWindowRegion.first
      seedRegistration(registrant.pid, configClaiming(base))
      const config = await BindConfig.resolve({}, {})
      expect(config.portWindow!.first).toBe(base)
      const foreign = configClaiming(base).allPorts
      foreign.forEach(port => expect(config.allPorts).not.toContain(port))
    })

    it("reaps a DEAD pid's registration instead of honoring it", async () => {
      const dead = spawnSync("/bin/true")
      expect(dead.pid).toBeGreaterThan(0)
      const file = seedRegistration(
        dead.pid,
        configClaiming(BindConfig.DefaultAnvil - 3)
      )
      const exclusions = BindConfig.readRegistryPortExclusions()
      expect(exclusions.has(BindConfig.DefaultAnvil)).toBe(false)
      expect(Fs.existsSync(file)).toBe(false) // reaped
    })

    it("reaps a malformed registration file", () => {
      Fs.mkdirSync(BindConfig.registryPath(), { recursive: true })
      const file = Path.join(
        BindConfig.registryPath(),
        `${process.ppid}${BindConfig.RegistryFileSuffix}`
      )
      Fs.writeFileSync(file, "not json {")
      const exclusions = BindConfig.readRegistryPortExclusions()
      // Only the standing reserved-band seed remains — nothing from the
      // malformed registration survived.
      expect(exclusions.size).toBe(
        BindConfig.ReservedAgavePortBand.last -
          BindConfig.ReservedAgavePortBand.first +
          1
      )
      expect(Fs.existsSync(file)).toBe(false) // reaped
    })

    it("findAvailable respects a live registration without writing one", async () => {
      const claimed = 51_777
      seedRegistration(registrant.pid, configClaiming(claimed))
      const port = await BindConfig.findAvailable(claimed)
      expect(port).not.toBe(claimed)
      // reading never registers THIS process
      expect(Fs.existsSync(BindConfig.registryFile())).toBe(false)
    })

    // The structural guarantee behind cross-resolve disjointness: every resolve
    // draws from its own claimed window, so even a compromised port lock cannot
    // produce a collision (the 2026-07-16 CI failure class — two concurrent
    // flows drew the same port and one cluster's nodeop died at bind).
    describe("port windows", () => {
      const region = () => BindConfig.FlowPortWindowRegion
      const width = () => BindConfig.FlowPortWindowWidth
      const windowAt = (index: number) => ({
        first: region().first + index * width(),
        last: region().first + (index + 1) * width() - 1
      })

      it("consecutive resolves claim disjoint windows with zero port overlap", async () => {
        const first = await BindConfig.resolve({}, {})
        const second = await BindConfig.resolve({}, {})
        expect(first.portWindow).toEqual(windowAt(0))
        expect(second.portWindow).toEqual(windowAt(1))
        const overlap = first.allPorts.filter(port =>
          second.allPorts.includes(port)
        )
        expect(overlap).toEqual([])
      })

      it("a live foreign WINDOW claim shifts this resolve to the next window", async () => {
        seedRegistration(
          registrant.pid,
          configClaiming(region().first, windowAt(0))
        )
        const config = await BindConfig.resolve({}, {})
        expect(config.portWindow).toEqual(windowAt(1))
        config.allPorts.forEach(port => {
          expect(port).toBeGreaterThanOrEqual(windowAt(1).first)
          expect(port).toBeLessThanOrEqual(windowAt(1).last)
        })
      })

      it("a DEAD pid's window claim is reaped and its window reused", async () => {
        const dead = spawnSync("/bin/true")
        expect(dead.pid).toBeGreaterThan(0)
        seedRegistration(dead.pid, configClaiming(region().first, windowAt(0)))
        const config = await BindConfig.resolve({}, {})
        expect(config.portWindow).toEqual(windowAt(0))
      })

      it("throws when every window is claimed by live registrations", async () => {
        const count = Math.floor((region().last - region().first + 1) / width())
        const file = Path.join(
          BindConfig.registryPath(),
          `${registrant.pid}${BindConfig.RegistryFileSuffix}`
        )
        Fs.mkdirSync(BindConfig.registryPath(), { recursive: true })
        const entries = Array.from({ length: count }, (_, index) =>
          configClaiming(windowAt(index).first, windowAt(index))
        )
        Fs.writeFileSync(file, JSON.stringify(entries))
        await expect(BindConfig.resolve({}, {})).rejects.toThrow(
          /are claimed by live resolves/
        )
      })
    })
  })
})
