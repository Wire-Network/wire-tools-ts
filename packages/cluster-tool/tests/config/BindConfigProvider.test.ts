import { jest } from "@jest/globals"
import { spawn, spawnSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import {
  BindConfigPortProtocol,
  type BindConfig
} from "@wireio/cluster-tool-shared"
import { Deferred, guard } from "@wireio/shared"
import { ProcessSignalName } from "@wireio/cluster-tool/cluster/processes"
import { ListenAllAddress, Localhost } from "@wireio/cluster-tool/utils"

/**
 * Options the fake `get-port` honors — the subset {@link BindConfigProvider}
 * passes (`port` preference + `exclude` set). Named (not inline) per repo style.
 */
interface FakeGetPortOptions {
  port?: number
  exclude?: Iterable<number>
}

/** Ephemeral ports the fake hands out start here — well clear of every default. */
const FakeEphemeralBase = 50000

/**
 * Deterministic in-memory model of `get-port`, so port outcomes are driven by
 * the test rather than whatever real host ports happen to be free while other
 * suites run in parallel (the whole point — see the bind-available-ports rule).
 *
 * Faithful to the three behaviors {@link BindConfigProvider} relies on:
 * - a preferred `port` is returned WHEN it is free (not taken, not locked, not
 *   excluded); otherwise a fresh ephemeral is returned (the fallback),
 * - `exclude` gates ONLY the explicit preferred candidate — real `get-port`
 *   never consults it on the port-0 (OS-assigned) fallback, so an ephemeral
 *   can land inside the caller's exclusion set; `pickPort`'s own claimed
 *   re-check is what rejects it, and the fake mirrors the asymmetry so that
 *   re-check is exercised for real,
 * - every returned port is LOCKED in-process, so consecutive calls never repeat
 *   — the same collision-avoidance real `get-port` provides. {@link clearLocks}
 *   drops those locks (what {@link BindConfigProvider.validate} does before re-probing).
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
    // `exclude` gates only the explicit preferred candidate — real get-port
    // never consults it on the port-0 (OS-assigned) fallback, where only
    // actually-bound ports and its own in-process locks apply.
    const preferredBlocked = new Set<number>([
        ...this.taken,
        ...this.locked,
        ...(options?.exclude ?? [])
      ]),
      ephemeralBlocked = new Set<number>([...this.taken, ...this.locked]),
      preferred = options?.port
    const chosen =
      !preferred || preferredBlocked.has(preferred)
        ? this.nextEphemeral(ephemeralBlocked)
        : preferred
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

// Intercept the ESM-only `get-port` that BindConfigProvider dynamically imports. Plain
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

describe("BindConfigProvider", () => {
  // Import AFTER the mock is registered so BindConfigProvider's cached get-port
  // is the fake. A static top-level import would load the real module first.
  let BindConfigProvider: typeof import("@wireio/cluster-tool/config").BindConfigProvider

  beforeAll(async () => {
    ;({ BindConfigProvider } = await import("@wireio/cluster-tool/config"))
  })

  beforeEach(() => {
    allocator.reset()
    mockUdpTakenPorts.clear()
    // Fresh registry per test — resolve() registers its ports, and a leftover
    // registration would leak exclusions into the next test's outcome. The
    // scratch dir itself is installed by tests/jest.setup.ts.
    Fs.rmSync(BindConfigProvider.registryPath(), {
      recursive: true,
      force: true
    })
  })

  describe("resolve", () => {
    it("prefers every default port when the defaults are free", async () => {
      const config = await BindConfigProvider.resolve({}, {})
      // Nothing taken → every daemon with a default gets exactly that default.
      expect(config.kiod.port).toBe(BindConfigProvider.DefaultKiod)
      expect(config.nodeop.ports.bios.http).toBe(
        BindConfigProvider.DefaultBiosHttp
      )
      expect(config.nodeop.ports.bios.p2p).toBe(
        BindConfigProvider.DefaultBiosP2p
      )
      expect(config.anvil.port).toBe(BindConfigProvider.DefaultAnvil)
      expect(config.solana.ports.http).toBe(BindConfigProvider.DefaultSolanaRpc)
      expect(config.solana.ports.faucet).toBe(
        BindConfigProvider.DefaultSolanaFaucet
      )
      expect(config.solana.ports.gossip).toBe(
        BindConfigProvider.DefaultSolanaGossip
      )
      expect(config.debuggingServer.port).toBe(
        BindConfigProvider.DefaultDebuggingServer
      )
    })

    it("falls back to an ephemeral when a default is taken", async () => {
      // Take three defaults; leave bios.http free to prove per-daemon independence.
      allocator.markTaken(
        BindConfigProvider.DefaultKiod,
        BindConfigProvider.DefaultAnvil,
        BindConfigProvider.DefaultSolanaRpc
      )
      const config = await BindConfigProvider.resolve({}, {})
      expect(config.kiod.port).not.toBe(BindConfigProvider.DefaultKiod)
      expect(config.kiod.port).toBeGreaterThan(0)
      expect(config.anvil.port).not.toBe(BindConfigProvider.DefaultAnvil)
      expect(config.anvil.port).toBeGreaterThan(0)
      expect(config.solana.ports.http).not.toBe(
        BindConfigProvider.DefaultSolanaRpc
      )
      expect(config.solana.ports.http).toBeGreaterThan(0)
      // The untaken default is still preferred.
      expect(config.nodeop.ports.bios.http).toBe(
        BindConfigProvider.DefaultBiosHttp
      )
    })

    it("populates every daemon with addresses + unique ports", async () => {
      const config = await BindConfigProvider.resolve(
        {},
        { producerCount: 2, batchOperatorCount: 3, underwriterCount: 1 }
      )
      expect(config.kiod.address).toBe(Localhost)
      expect(config.nodeop.ports.producers).toHaveLength(2)
      expect(config.nodeop.ports.batch).toHaveLength(3)
      expect(config.nodeop.ports.underwriters).toHaveLength(1)
      const ports = BindConfigProvider.allPorts(config)
      expect(new Set(ports).size).toBe(ports.length)
      expect(ports.every(port => port > 0)).toBe(true)
    })

    it("binds every address to the bind-all address when bindAll is set", async () => {
      const config = await BindConfigProvider.resolve({}, { bindAll: true })
      expect(config.kiod.address).toBe(ListenAllAddress)
      expect(config.nodeop.address).toBe(ListenAllAddress)
      expect(config.anvil.address).toBe(ListenAllAddress)
      expect(config.solana.address).toBe(ListenAllAddress)
      expect(config.debuggingServer.address).toBe(ListenAllAddress)
    })

    it("honors a per-daemon address override", async () => {
      const config = await BindConfigProvider.resolve(
        { anvil: { address: ListenAllAddress } },
        {}
      )
      // bindAll is NOT set, so the default would be loopback — the override wins.
      expect(config.anvil.address).toBe(ListenAllAddress)
      expect(config.kiod.address).toBe(Localhost)
    })

    it("throws when a pinned port is unavailable", async () => {
      const pinned = 7777
      allocator.markTaken(pinned)
      await expect(
        BindConfigProvider.resolve({ kiod: { port: pinned } }, {})
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("uses a caller-pinned port when it is free", async () => {
      const pinned = 7777
      const config = await BindConfigProvider.resolve(
        { kiod: { port: pinned } },
        {}
      )
      expect(config.kiod.port).toBe(pinned)
    })
  })

  describe("isPortAvailable", () => {
    it("is false for a taken port and true for a free one", async () => {
      const port = 6543
      allocator.markTaken(port)
      expect(await BindConfigProvider.isPortAvailable(port)).toBe(false)
      allocator.reset()
      expect(await BindConfigProvider.isPortAvailable(port)).toBe(true)
    })
  })

  describe("validate", () => {
    it("is true when every resolved port is free", async () => {
      const config = await BindConfigProvider.resolve({}, {})
      expect(await BindConfigProvider.validate(config)).toBe(true)
    })

    it("is false once a resolved port becomes taken", async () => {
      const config = await BindConfigProvider.resolve({}, {})
      // A port that was free at resolve is now occupied — validate must catch it.
      allocator.markTaken(config.anvil.port)
      expect(await BindConfigProvider.validate(config)).toBe(false)
    })
  })

  describe("solana dynamic port range", () => {
    it("resolves an aligned, full-width window included in allPorts", async () => {
      const config = await BindConfigProvider.resolve({}, {})
      const { first, last } = config.solana.ports.dynamicRange
      expect(last - first + 1).toBe(
        BindConfigProvider.SolanaDynamicPortRangeSize
      )
      expect(first).toBeGreaterThanOrEqual(
        BindConfigProvider.DefaultSolanaDynamicPortFirst
      )
      // Scanned windows step by the range size from the default first port.
      expect(
        (first - BindConfigProvider.DefaultSolanaDynamicPortFirst) %
          BindConfigProvider.SolanaDynamicPortRangeSize
      ).toBe(0)
      expect(BindConfigProvider.allPorts(config)).toEqual(
        expect.arrayContaining([first, last])
      )
    })

    it("two resolves claim DISJOINT windows (the co-running-validator guarantee)", async () => {
      const first = await BindConfigProvider.resolve({}, {})
      const second = await BindConfigProvider.resolve({}, {})
      const a = first.solana.ports.dynamicRange
      const b = second.solana.ports.dynamicRange
      const overlaps = a.first <= b.last && b.first <= a.last
      expect(overlaps).toBe(false)
    })

    it("uses a caller-pinned window when it is free", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfigProvider.SolanaDynamicPortRangeSize - 1
      }
      const config = await BindConfigProvider.resolve(
        { solana: { ports: { dynamicRange: pinned } } },
        {}
      )
      expect(config.solana.ports.dynamicRange).toEqual(pinned)
    })

    it("throws when a pinned window is unavailable", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfigProvider.SolanaDynamicPortRangeSize - 1
      }
      // One occupied port anywhere in the window poisons the whole pin.
      allocator.markTaken(13_007)
      await expect(
        BindConfigProvider.resolve(
          { solana: { ports: { dynamicRange: pinned } } },
          {}
        )
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("uses a caller-pinned gossip port when it is free", async () => {
      const pinned = 14_500
      const config = await BindConfigProvider.resolve(
        { solana: { ports: { gossip: pinned } } },
        {}
      )
      expect(config.solana.ports.gossip).toBe(pinned)
    })

    it("throws when a pinned gossip port is taken (same pin semantics as every daemon)", async () => {
      const pinned = 14_600
      allocator.markTaken(pinned)
      await expect(
        BindConfigProvider.resolve(
          { solana: { ports: { gossip: pinned } } },
          {}
        )
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("findAvailableRange returns a full-width window without registering", async () => {
      const window = await BindConfigProvider.findAvailableRange()
      expect(window.last - window.first + 1).toBe(
        BindConfigProvider.SolanaDynamicPortRangeSize
      )
      // reading never registers THIS process (mirrors findAvailable)
      expect(Fs.existsSync(BindConfigProvider.registryFile())).toBe(false)
    })
  })

  // agave binds implicit sockets first-free from its built-in 8000-10000
  // range regardless of --gossip-port/--dynamic-port-range, so the band is a
  // standing registration: NOTHING the harness assigns may sit inside it —
  // not a default, not an ephemeral fallback, not a caller pin, not a window.
  describe("reserved agave band (8000-10000 is never assigned)", () => {
    it("every default preference and the window base sit OUTSIDE the band (and clear of the solana ws companion rpc+1)", () => {
      const band = BindConfigProvider.ReservedAgavePortBand
      const defaults = [
        BindConfigProvider.DefaultKiod,
        BindConfigProvider.DefaultBiosHttp,
        BindConfigProvider.DefaultBiosP2p,
        BindConfigProvider.DefaultAnvil,
        BindConfigProvider.DefaultSolanaRpc,
        BindConfigProvider.DefaultSolanaFaucet,
        BindConfigProvider.DefaultSolanaGossip,
        BindConfigProvider.DefaultDebuggingServer,
        BindConfigProvider.DefaultSolanaDynamicPortFirst
      ]
      defaults.forEach(port =>
        expect(port < band.first || port > band.last).toBe(true)
      )
      // rpc+1 is agave's automatic websocket port — no default may collide.
      expect(defaults).not.toContain(BindConfigProvider.DefaultSolanaRpc + 1)
    })

    it("findAvailable never returns an in-band port even when preferred and OS-free", async () => {
      const inBand = 8899
      const port = await BindConfigProvider.findAvailable(inBand)
      expect(port).not.toBe(inBand)
      expect(
        port < BindConfigProvider.ReservedAgavePortBand.first ||
          port > BindConfigProvider.ReservedAgavePortBand.last
      ).toBe(true)
    })

    it("throws on a caller pin inside the band, naming the band", async () => {
      await expect(
        BindConfigProvider.resolve({ solana: { ports: { http: 8899 } } }, {})
      ).rejects.toThrow(/reserved agave validator band 8000-10000/)
    })

    it("throws on a pinned window overlapping the band, naming the band", async () => {
      const pinned = {
        first: 9_990,
        last: 9_990 + BindConfigProvider.SolanaDynamicPortRangeSize - 1
      }
      await expect(
        BindConfigProvider.resolve(
          { solana: { ports: { dynamicRange: pinned } } },
          {}
        )
      ).rejects.toThrow(/reserved agave validator band 8000-10000/)
    })

    it("resolve produces NO in-band port and claims the solana ws companion (rpc+1)", async () => {
      const config = await BindConfigProvider.resolve({}, {})
      const band = BindConfigProvider.ReservedAgavePortBand
      BindConfigProvider.allPorts(config).forEach(port =>
        expect(port < band.first || port > band.last).toBe(true)
      )
      expect(BindConfigProvider.allPorts(config)).toContain(
        config.solana.ports.http + 1
      )
    })
  })

  // A UDP-only holder passes every TCP probe (get-port) while still panicking
  // agave at first bind — the 2026-07-15 gate failure class. UDP-role ports
  // (gossip, dynamic range) must consult the UDP probe; TCP-role ports must
  // not change behavior.
  describe("UDP-role ports (non-registry UDP holders)", () => {
    it("gossip falls back to an ephemeral when the default is UDP-held (TCP probe passes)", async () => {
      mockUdpTakenPorts.add(BindConfigProvider.DefaultSolanaGossip)
      const config = await BindConfigProvider.resolve({}, {})
      expect(config.solana.ports.gossip).not.toBe(
        BindConfigProvider.DefaultSolanaGossip
      )
      expect(mockUdpTakenPorts.has(config.solana.ports.gossip)).toBe(false)
      // TCP-role defaults are untouched by the UDP holder.
      expect(config.solana.ports.http).toBe(BindConfigProvider.DefaultSolanaRpc)
    })

    it("throws when a pinned gossip port is UDP-held", async () => {
      const pinned = 14_700
      mockUdpTakenPorts.add(pinned)
      await expect(
        BindConfigProvider.resolve(
          { solana: { ports: { gossip: pinned } } },
          {}
        )
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("dynamic range skips a window containing a UDP-held port", async () => {
      mockUdpTakenPorts.add(
        BindConfigProvider.DefaultSolanaDynamicPortFirst + 5
      )
      const config = await BindConfigProvider.resolve({}, {})
      expect(config.solana.ports.dynamicRange.first).toBe(
        BindConfigProvider.DefaultSolanaDynamicPortFirst +
          BindConfigProvider.SolanaDynamicPortRangeSize
      )
    })

    it("throws when a pinned window contains a UDP-held port", async () => {
      const pinned = {
        first: 13_000,
        last: 13_000 + BindConfigProvider.SolanaDynamicPortRangeSize - 1
      }
      mockUdpTakenPorts.add(13_042)
      await expect(
        BindConfigProvider.resolve(
          { solana: { ports: { dynamicRange: pinned } } },
          {}
        )
      ).rejects.toThrow(/pinned but unavailable/)
    })

    it("findAvailable redraws past a UDP-held preferred port only under the udp protocol", async () => {
      const preferred = 14_800
      mockUdpTakenPorts.add(preferred)
      // tcp (default): the UDP holder is irrelevant — preferred wins.
      expect(await BindConfigProvider.findAvailable(preferred)).toBe(preferred)
      allocator.clearLocks()
      // udp: the holder forces a redraw to a UDP-free ephemeral.
      const port = await BindConfigProvider.findAvailable(
        preferred,
        BindConfigPortProtocol.udp
      )
      expect(port).not.toBe(preferred)
      expect(mockUdpTakenPorts.has(port)).toBe(false)
    })
  })

  describe("findAvailable", () => {
    it("returns the preferred port when it is free", async () => {
      expect(
        await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
      ).toBe(BindConfigProvider.DefaultAnvil)
    })

    it("returns a different free port when the preferred is taken", async () => {
      allocator.markTaken(BindConfigProvider.DefaultAnvil)
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultAnvil
      )
      expect(port).not.toBe(BindConfigProvider.DefaultAnvil)
      expect(port).toBeGreaterThan(0)
    })
  })

  describe("pickPort", () => {
    it("redraws an OS-assigned candidate that lands inside the claimed set", async () => {
      // get-port consults `exclude` only for explicit candidates — its port-0
      // (OS-assigned) fallback returns unchecked, so the OS can hand back a
      // port another process resolved but has not bound yet. pickPort itself
      // must reject and redraw. The fake's ephemeral cursor makes the
      // collision deterministic: the first draw is FakeEphemeralBase + 1,
      // which the claimed set poisons; the redraw yields the next cursor port.
      const claimed = new Set([FakeEphemeralBase + 1])
      const picked = await BindConfigProvider.pickPort(
        null,
        null,
        claimed,
        "pickPort.test"
      )
      expect(claimed.has(picked)).toBe(false)
      expect(picked).toBe(FakeEphemeralBase + 2)
    })
  })

  describe("cross-process registry", () => {
    /** A minimal resolved BindConfig whose only interesting claim is `port`. */
    function configClaiming(port: number): BindConfig {
      return {
        kiod: { address: Localhost, port },
        nodeop: {
          address: Localhost,
          ports: {
            bios: { http: port + 1, p2p: port + 2 },
            producers: [],
            batch: [],
            underwriters: []
          }
        },
        anvil: { address: Localhost, port: port + 3 },
        solana: {
          address: Localhost,
          ports: {
            http: port + 4,
            faucet: port + 5,
            gossip: port + 8,
            // Width-1 window keeps the claim minimal (one extra port).
            dynamicRange: { first: port + 7, last: port + 7 }
          }
        },
        debuggingServer: {
          address: Localhost,
          port: port + 6
        }
      }
    }

    /** Write a registry file for `pid` claiming `config`'s ports. */
    function seedRegistration(pid: number, config: BindConfig): string {
      Fs.mkdirSync(BindConfigProvider.registryPath(), { recursive: true })
      const file = Path.join(
        BindConfigProvider.registryPath(),
        `${pid}${BindConfigProvider.RegistryFileSuffix}`
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
      expect(BindConfigProvider.registryPath()).toBe(
        process.env.WIRE_BIND_REGISTRY_PATH
      )
    })

    it("resolve registers its ports in this process's file, appending per resolve", async () => {
      const first = await BindConfigProvider.resolve({}, {})
      const second = await BindConfigProvider.resolve({}, {})
      const entries = JSON.parse(
        Fs.readFileSync(BindConfigProvider.registryFile(), "utf8")
      )
      expect(Array.isArray(entries)).toBe(true)
      expect(entries).toHaveLength(2)
      expect(entries[0].kiod.port).toBe(first.kiod.port)
      expect(entries[1].kiod.port).toBe(second.kiod.port)
      // The second resolve read the first's registration — zero overlap.
      const overlap = BindConfigProvider.allPorts(first).filter(port =>
        BindConfigProvider.allPorts(second).includes(port)
      )
      expect(overlap).toEqual([])
    })

    it("resolve excludes a LIVE foreign registration's ports", async () => {
      // configClaiming puts its anvil claim at base+3, so base = DefaultAnvil-3
      // makes the foreign registration claim the anvil default: resolve must
      // fall back to an ephemeral for anvil while other defaults stay.
      seedRegistration(
        registrant.pid,
        configClaiming(BindConfigProvider.DefaultAnvil - 3)
      )
      const config = await BindConfigProvider.resolve({}, {})
      expect(config.anvil.port).not.toBe(BindConfigProvider.DefaultAnvil)
      expect(config.kiod.port).toBe(BindConfigProvider.DefaultKiod)
    })

    it("reaps a DEAD pid's registration instead of honoring it", async () => {
      const dead = spawnSync("/bin/true")
      expect(dead.pid).toBeGreaterThan(0)
      const file = seedRegistration(
        dead.pid,
        configClaiming(BindConfigProvider.DefaultAnvil - 3)
      )
      const exclusions = BindConfigProvider.readRegistryPortExclusions()
      expect(exclusions.has(BindConfigProvider.DefaultAnvil)).toBe(false)
      expect(Fs.existsSync(file)).toBe(false) // reaped
    })

    it("reaps a malformed registration file", () => {
      Fs.mkdirSync(BindConfigProvider.registryPath(), { recursive: true })
      const file = Path.join(
        BindConfigProvider.registryPath(),
        `${process.ppid}${BindConfigProvider.RegistryFileSuffix}`
      )
      Fs.writeFileSync(file, "not json {")
      const exclusions = BindConfigProvider.readRegistryPortExclusions()
      // Only the standing reserved-band seed remains — nothing from the
      // malformed registration survived.
      expect(exclusions.size).toBe(
        BindConfigProvider.ReservedAgavePortBand.last -
          BindConfigProvider.ReservedAgavePortBand.first +
          1
      )
      expect(Fs.existsSync(file)).toBe(false) // reaped
    })

    it("findAvailable respects a live registration without writing one", async () => {
      const claimed = 51_777
      seedRegistration(registrant.pid, configClaiming(claimed))
      const port = await BindConfigProvider.findAvailable(claimed)
      expect(port).not.toBe(claimed)
      // reading never registers THIS process
      expect(Fs.existsSync(BindConfigProvider.registryFile())).toBe(false)
    })
  })
})
