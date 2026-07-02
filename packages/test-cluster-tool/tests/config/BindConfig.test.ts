import { jest } from "@jest/globals"
import { spawnSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"

/**
 * Options the fake `get-port` honors — the subset {@link BindConfig} passes
 * (`port` preference + `exclude` set). Named (not inline) per repo style.
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
 * Faithful to the two behaviors {@link BindConfig} relies on:
 * - a preferred `port` is returned WHEN it is free (not taken, not locked, not
 *   excluded); otherwise a fresh ephemeral is returned (the fallback),
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
    const preferred = options?.port
    const chosen =
      preferred !== undefined && !blocked.has(preferred)
        ? preferred
        : this.nextEphemeral(blocked)
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
  default: jest.fn(async (options?: FakeGetPortOptions) => allocator.allocate(options)),
  clearLockedPorts: jest.fn(() => allocator.clearLocks())
}))

describe("BindConfig", () => {
  // Import AFTER the mock is registered so BindConfig's cached get-port is the
  // fake. A static top-level import would load the real module first.
  let BindConfig: typeof import("@wireio/test-cluster-tool/config").BindConfig

  beforeAll(async () => {
    ;({ BindConfig } = await import("@wireio/test-cluster-tool/config"))
  })

  beforeEach(() => {
    allocator.reset()
    // Fresh registry per test — resolve() registers its ports, and a leftover
    // registration would leak exclusions into the next test's outcome. The
    // scratch dir itself is installed by tests/jest.setup.ts.
    Fs.rmSync(BindConfig.registryPath(), { recursive: true, force: true })
  })

  describe("resolve", () => {
    it("prefers every default port when the defaults are free", async () => {
      const config = await BindConfig.resolve({}, {})
      // Nothing taken → every daemon with a default gets exactly that default.
      expect(config.kiod.port).toBe(BindConfig.DefaultKiod)
      expect(config.nodeop.ports.bios.http).toBe(BindConfig.DefaultBiosHttp)
      expect(config.nodeop.ports.bios.p2p).toBe(BindConfig.DefaultBiosP2p)
      expect(config.anvil.port).toBe(BindConfig.DefaultAnvil)
      expect(config.solana.ports.http).toBe(BindConfig.DefaultSolanaRpc)
      expect(config.solana.ports.faucet).toBe(BindConfig.DefaultSolanaFaucet)
      expect(config.debuggingServer.port).toBe(BindConfig.DefaultDebuggingServer)
    })

    it("falls back to an ephemeral when a default is taken", async () => {
      // Take three defaults; leave bios.http free to prove per-daemon independence.
      allocator.markTaken(
        BindConfig.DefaultKiod,
        BindConfig.DefaultAnvil,
        BindConfig.DefaultSolanaRpc
      )
      const config = await BindConfig.resolve({}, {})
      expect(config.kiod.port).not.toBe(BindConfig.DefaultKiod)
      expect(config.kiod.port).toBeGreaterThan(0)
      expect(config.anvil.port).not.toBe(BindConfig.DefaultAnvil)
      expect(config.anvil.port).toBeGreaterThan(0)
      expect(config.solana.ports.http).not.toBe(BindConfig.DefaultSolanaRpc)
      expect(config.solana.ports.http).toBeGreaterThan(0)
      // The untaken default is still preferred.
      expect(config.nodeop.ports.bios.http).toBe(BindConfig.DefaultBiosHttp)
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
    /** A minimal resolved BindConfig whose only interesting claim is `port`. */
    function configClaiming(port: number) {
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
          ports: { http: port + 4, faucet: port + 5 }
        },
        { address: BindConfig.LoopbackAddress, port: port + 6 }
      )
    }

    /** Write a registry file for `pid` claiming `config`'s ports. */
    function seedRegistration(pid: number, config: InstanceType<typeof BindConfig>): string {
      Fs.mkdirSync(BindConfig.registryPath(), { recursive: true })
      const file = Path.join(
        BindConfig.registryPath(),
        `${pid}${BindConfig.RegistryFileSuffix}`
      )
      Fs.writeFileSync(file, JSON.stringify([config]))
      return file
    }

    it("registryPath honors the env override (installed by jest.setup)", () => {
      expect(BindConfig.registryPath()).toBe(process.env.WIRE_BIND_REGISTRY_PATH)
    })

    it("resolve registers its ports in this process's file, appending per resolve", async () => {
      const first = await BindConfig.resolve({}, {})
      const second = await BindConfig.resolve({}, {})
      const entries = JSON.parse(Fs.readFileSync(BindConfig.registryFile(), "utf8"))
      expect(Array.isArray(entries)).toBe(true)
      expect(entries).toHaveLength(2)
      expect(entries[0].kiod.port).toBe(first.kiod.port)
      expect(entries[1].kiod.port).toBe(second.kiod.port)
      // The second resolve read the first's registration — zero overlap.
      const overlap = first.allPorts.filter(port => second.allPorts.includes(port))
      expect(overlap).toEqual([])
    })

    it("resolve excludes a LIVE foreign registration's ports", async () => {
      // process.ppid (the jest parent) is a live node process ≠ this pid.
      // configClaiming puts its anvil claim at base+3, so base = DefaultAnvil-3
      // makes the foreign registration claim the anvil default: resolve must
      // fall back to an ephemeral for anvil while other defaults stay.
      seedRegistration(process.ppid, configClaiming(BindConfig.DefaultAnvil - 3))
      const config = await BindConfig.resolve({}, {})
      expect(config.anvil.port).not.toBe(BindConfig.DefaultAnvil)
      expect(config.kiod.port).toBe(BindConfig.DefaultKiod)
    })

    it("reaps a DEAD pid's registration instead of honoring it", async () => {
      const dead = spawnSync("/bin/true")
      expect(dead.pid).toBeGreaterThan(0)
      const file = seedRegistration(dead.pid, configClaiming(BindConfig.DefaultAnvil - 3))
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
      expect(exclusions.size).toBe(0)
      expect(Fs.existsSync(file)).toBe(false) // reaped
    })

    it("findAvailable respects a live registration without writing one", async () => {
      const claimed = 51_777
      seedRegistration(process.ppid, configClaiming(claimed))
      const port = await BindConfig.findAvailable(claimed)
      expect(port).not.toBe(claimed)
      // reading never registers THIS process
      expect(Fs.existsSync(BindConfig.registryFile())).toBe(false)
    })
  })
})
