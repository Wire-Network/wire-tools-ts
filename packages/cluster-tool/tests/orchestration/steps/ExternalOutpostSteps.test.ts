import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SlugName } from "@wireio/sdk-core"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import {
  EthereumOutpostBootstrapper,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureExternalOutposts } from "../../config/resolveEnvironmentFixture.js"

describe("Steps.externalOutpost (materialize + gates)", () => {
  /** A liqEth deploy record the config may carry. */
  const LiqEthAddresses = {
      LiqEthToken: "0x4444444444444444444444444444444444444444"
    },
    signal = new AbortController().signal
  let dir: string, dataPath: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "external-outpost-"))
    dataPath = Path.join(dir, "cluster", "data")
  })

  afterEach(() => Fs.rmSync(dir, { recursive: true, force: true }))

  /** A context over a real data dir whose config carries `outposts`. */
  function externalContext(outposts = fixtureExternalOutposts()) {
    return fixtureContext({
      clusterPath: Path.join(dir, "cluster"),
      dataPath,
      externalOutposts: outposts
    })
  }

  /** Parse a JSON record the materialize step wrote. */
  function readRecord(file: string): unknown {
    return JSON.parse(Fs.readFileSync(file, "utf-8"))
  }

  it("writes the trusted outpost addresses to the canonical deploy record — and no optional record", async () => {
    const ctx = externalContext()
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    const deploymentsDir = ClusterConfigProvider.ethereumDeploymentsPath(
      ctx.config
    )
    expect(
      readRecord(
        Path.join(deploymentsDir, EthereumOutpostBootstrapper.OutpostAddressesFile)
      )
    ).toEqual(ctx.config.externalOutposts.ethereum.outpostAddresses)
    expect(
      Fs.existsSync(
        Path.join(deploymentsDir, EthereumOutpostBootstrapper.LiqEthAddressesFile)
      )
    ).toBe(false)
    expect(
      Fs.existsSync(Path.join(dataPath, SolanaFundingTool.SolMockMintsFilename))
    ).toBe(false)
  })

  it("writes the liqEth addresses and SPL mints when the config carries them", async () => {
    const outposts = fixtureExternalOutposts()
    outposts.ethereum.liqEthAddresses = LiqEthAddresses
    outposts.solana.mints = [
      { code: 1_234, mint: outposts.solana.programId, decimals: 9 }
    ]
    const ctx = externalContext(outposts)
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    expect(
      readRecord(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          EthereumOutpostBootstrapper.LiqEthAddressesFile
        )
      )
    ).toEqual(LiqEthAddresses)
    expect(
      readRecord(Path.join(dataPath, SolanaFundingTool.SolMockMintsFilename))
    ).toEqual(outposts.solana.mints)
  })

  it("materialize requires config.externalOutposts (local mode)", async () => {
    await expect(
      Steps.externalOutpost.runMaterialize(fixtureContext(), null, signal)
    ).rejects.toThrow(/external-outpost mode only/)
  })

  describe("outbound-envelope bootstrap gate", () => {
    const EthereumCode = "ETH",
      SolanaCode = "SOL",
      DepotCode = "WIRE"

    /**
     * Which carrier a `slug_name` cell arrives in. The depot renders the
     * canonical spelling once it registers the ABI builtin; before that a slug
     * reflects as the `{value}` wrapper. Both occur during the rollout, so the
     * gate is exercised against each.
     */
    enum SlugCarrier {
      spelling = "spelling",
      wrapper = "wrapper"
    }

    /** A `sysio.chains::chains` row in the given carrier. */
    function chainRow(code: string, isDepot: boolean, carrier: SlugCarrier) {
      return {
        code:
          carrier === SlugCarrier.spelling
            ? code
            : { value: SlugName.from(code) },
        is_depot: isDepot
      }
    }

    /**
     * A context whose `wire` answers `getChains` / `getOutboundEnvelopes` /
     * `getEnvelopes` from the supplied rows — installed as an OWN accessor on a
     * throwaway context, never a prototype spy.
     */
    function gateContext(outboundCodes: string[], carrier: SlugCarrier) {
      const ctx = externalContext(),
        wireStub = {
          getChains: async () => ({
            rows: [
              chainRow(DepotCode, true, carrier),
              chainRow(EthereumCode, false, carrier),
              chainRow(SolanaCode, false, carrier)
            ]
          }),
          // `outenvelopes.chain_code` is declared `uint64`, so it always
          // carries the PACKED value — never a spelling, in either carrier.
          getOutboundEnvelopes: async () => ({
            rows: outboundCodes.map(code => ({
              chain_code: SlugName.from(code)
            }))
          }),
          getEnvelopes: async () => ({ rows: [] })
        }
      Object.defineProperty(ctx, "wire", {
        get: () => wireStub,
        configurable: true
      })
      return ctx
    }

    // Both carriers, because the gate must hold on either side of the depot
    // registering the `slug_name` ABI builtin. Reading the spelling carrier
    // with `String(code.value)` yielded "undefined" for every chain, so the
    // gate could never match and external bootstrap timed out.
    it.each([SlugCarrier.spelling, SlugCarrier.wrapper])(
      "passes once EVERY registered (non-depot) chain has a queued outbound envelope (%s carrier)",
      async carrier => {
        await expect(
          Steps.externalOutpost.runOutboundEnvelopesQueued(
            gateContext([EthereumCode, SolanaCode], carrier),
            signal
          )
        ).resolves.toBeUndefined()
      }
    )

    it("enriches a failed gate with the expected outposts, preserving the cause", async () => {
      // A rejecting `outenvelopes` read propagates straight out of the poll —
      // the fast path through the same catch a timeout takes.
      const ctx = externalContext(),
        cause = new Error("outenvelopes read failed")
      Object.defineProperty(ctx, "wire", {
        get: () => ({
          getChains: async () => ({
            rows: [
              chainRow(DepotCode, true, SlugCarrier.spelling),
              chainRow(EthereumCode, false, SlugCarrier.spelling)
            ]
          }),
          getOutboundEnvelopes: async () => {
            throw cause
          },
          getEnvelopes: async () => ({ rows: [] })
        }),
        configurable: true
      })
      await expect(
        Steps.externalOutpost.runOutboundEnvelopesQueued(ctx, signal)
      ).rejects.toThrow(
        /queued no outbound envelope for every registered outpost/
      )
      await expect(
        Steps.externalOutpost
          .runOutboundEnvelopesQueued(ctx, signal)
          .catch((error: Error) => error.message)
      ).resolves.toContain(EthereumCode)
    })

    it("fails fast when the chains registry names no outpost at all", async () => {
      const ctx = externalContext()
      Object.defineProperty(ctx, "wire", {
        get: () => ({ getChains: async () => ({ rows: [] }) }),
        configurable: true
      })
      await expect(
        Steps.externalOutpost.runOutboundEnvelopesQueued(ctx, signal)
      ).rejects.toThrow(/no registered outpost \(non-depot\) chain/)
    })

    it("pins the step ceiling ABOVE its inner poll budget", () => {
      expect(Steps.externalOutpost.OutboundEnvelopesTimeoutMs).toBeGreaterThan(
        Steps.externalOutpost.OutboundEnvelopesPollBudgetMs
      )
    })

    it("planOutboundEnvelopesQueued defaults its ceiling to the named constant", () => {
      const step = Steps.externalOutpost.planOutboundEnvelopesQueued(
        Report.Actor.Sysio,
        "verify-outbound-envelopes",
        "every registered outpost has a queued outbound envelope"
      )
      expect(step.options.timeoutMs).toBe(
        Steps.externalOutpost.OutboundEnvelopesTimeoutMs
      )
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    })
  })
})
