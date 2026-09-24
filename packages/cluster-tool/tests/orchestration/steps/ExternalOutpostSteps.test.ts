import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { OperatorDaemonArtifactsKey } from "@wireio/cluster-tool/orchestration/outputs"
import { Report } from "@wireio/cluster-tool/report"
import { OperatorDaemonTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

describe("Steps.externalOutpost (materialize + publish)", () => {
  const ProgramId = "GrqvbZLCLkfeSQqvE7rL8XKHVWjNhAG2faLsY8yr9tD5",
    OppAddress = "0x1111111111111111111111111111111111111111",
    RequiredInstructions = [
      { name: "epoch_in" },
      { name: "commit_underwrite" },
      { name: "request_swap" }
    ],
    signal = new AbortController().signal
  let dir: string,
    sourceDir: string,
    dataPath: string,
    addressFile: string,
    abiFile: string,
    idlFile: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "external-outpost-"))
    sourceDir = Path.join(dir, "src")
    dataPath = Path.join(dir, "cluster", "data")
    Fs.mkdirSync(sourceDir, { recursive: true })
    addressFile = Path.join(sourceDir, "outpost-addrs.json")
    abiFile = Path.join(sourceDir, "OPP.json")
    idlFile = Path.join(sourceDir, "liqsol_core.json")
    Fs.writeFileSync(
      addressFile,
      JSON.stringify({
        OPP: OppAddress,
        OPPInbound: "0x2222222222222222222222222222222222222222",
        OperatorRegistry: "0x3333333333333333333333333333333333333333",
        ReserveManager: "0x4444444444444444444444444444444444444444"
      })
    )
    Fs.writeFileSync(
      abiFile,
      JSON.stringify({ contractName: "OPP", address: OppAddress, abi: [] })
    )
    Fs.writeFileSync(
      idlFile,
      JSON.stringify({ address: ProgramId, instructions: RequiredInstructions })
    )
  })

  afterEach(() => Fs.rmSync(dir, { recursive: true, force: true }))

  /** A context whose config references the temp source files + a real data dir. */
  function externalContext() {
    return fixtureContext({
      clusterPath: Path.join(dir, "cluster"),
      dataPath,
      externalOutposts: {
        ethereum: { addressFile, abiFiles: [abiFile], chainId: 11_155_111 },
        solana: { idlFile }
      }
    })
  }

  it("materializes the config-referenced files into the canonical data dir", async () => {
    const ctx = externalContext()
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    const deploymentsDir = ClusterConfigProvider.ethereumDeploymentsPath(
      ctx.config
    )
    expect(Fs.existsSync(Path.join(deploymentsDir, "outpost-addrs.json"))).toBe(
      true
    )
    expect(
      Fs.existsSync(
        Path.join(dataPath, OperatorDaemonTool.EthereumAbiSubpath, "OPP.json")
      )
    ).toBe(true)
    expect(
      Fs.existsSync(
        Path.join(
          dataPath,
          OperatorDaemonTool.SolanaIdlSubpath,
          OperatorDaemonTool.SolanaIdlFilename
        )
      )
    ).toBe(true)
  })

  it("publishes OperatorDaemonArtifacts from the MATERIALIZED data dir (not config)", async () => {
    const ctx = externalContext()
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    await Steps.externalOutpost.runPublishArtifacts(ctx, null, signal)
    const artifacts = ctx.outputs.assert(OperatorDaemonArtifactsKey)
    expect(artifacts.ethereumAddresses.OPP).toBe(OppAddress)
    expect(
      artifacts.ethereumAbiFiles.some(file => file.endsWith("OPP.json"))
    ).toBe(true)
    expect(
      JSON.parse(
        Fs.readFileSync(artifacts.ethereumClientConfigurationFile, "utf-8")
      )
    ).toEqual({
      schema_version: 1,
      clients: [
        {
          connection: {
            client_id: OperatorDaemonTool.EthereumClientId,
            signature_provider_id:
              OperatorDaemonTool.EthereumSignatureProviderId,
            rpc_url: OperatorDaemonTool.networkFromConfig(ctx.config)
              .ethereumRpcUrl
          },
          chain_id: 11_155_111
        }
      ]
    })
    expect(artifacts.solanaProgramId).toBe(ProgramId)
    expect(artifacts.solanaIdlFile).toContain(
      OperatorDaemonTool.SolanaIdlFilename
    )
  })

  it("materialize fails fast when a referenced source file is absent", async () => {
    Fs.rmSync(idlFile)
    await expect(
      Steps.externalOutpost.runMaterialize(externalContext(), null, signal)
    ).rejects.toThrow(/source file not found/)
  })

  it("materialize requires config.externalOutposts (local mode)", async () => {
    await expect(
      Steps.externalOutpost.runMaterialize(fixtureContext(), null, signal)
    ).rejects.toThrow(/external-outpost mode only/)
  })

  it("publish fails before materialize (data dir empty)", async () => {
    await expect(
      Steps.externalOutpost.runPublishArtifacts(externalContext(), null, signal)
    ).rejects.toThrow(/materialize must run first/)
  })

  it("publish fails when a required ETH contract address is missing", async () => {
    Fs.writeFileSync(addressFile, JSON.stringify({ OPP: OppAddress }))
    const ctx = externalContext()
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    await expect(
      Steps.externalOutpost.runPublishArtifacts(ctx, null, signal)
    ).rejects.toThrow(/missing the OPPInbound address/)
  })

  it("publish fails when a required SOL IDL instruction is missing", async () => {
    Fs.writeFileSync(
      idlFile,
      JSON.stringify({
        address: ProgramId,
        instructions: [{ name: "epoch_in" }]
      })
    )
    const ctx = externalContext()
    await Steps.externalOutpost.runMaterialize(ctx, null, signal)
    await expect(
      Steps.externalOutpost.runPublishArtifacts(ctx, null, signal)
    ).rejects.toThrow(/missing the 'commit_underwrite' instruction/)
  })

  describe("outbound-envelope bootstrap gate", () => {
    const EthereumChainCode = 101,
      SolanaChainCode = 202,
      DepotChainCode = 1

    /** A `sysio.chains::chains` row, wrapped exactly as the typed accessor yields it. */
    function chainRow(code: number, isDepot: boolean) {
      return { code: { value: code }, is_depot: isDepot }
    }

    /**
     * A context whose `wire` answers `getChains` / `getOutboundEnvelopes` /
     * `getEnvelopes` from the supplied rows — installed as an OWN accessor on a
     * throwaway context, never a prototype spy.
     */
    function gateContext(outboundChainCodes: number[]) {
      const ctx = externalContext(),
        wireStub = {
          getChains: async () => ({
            rows: [
              chainRow(DepotChainCode, true),
              chainRow(EthereumChainCode, false),
              chainRow(SolanaChainCode, false)
            ]
          }),
          getOutboundEnvelopes: async () => ({
            rows: outboundChainCodes.map(chain_code => ({ chain_code }))
          }),
          getEnvelopes: async () => ({ rows: [] })
        }
      Object.defineProperty(ctx, "wire", {
        get: () => wireStub,
        configurable: true
      })
      return ctx
    }

    it("passes once EVERY registered (non-depot) chain has a queued outbound envelope", async () => {
      await expect(
        Steps.externalOutpost.runOutboundEnvelopesQueued(
          gateContext([EthereumChainCode, SolanaChainCode]),
          signal
        )
      ).resolves.toBeUndefined()
    })

    it("enriches a failed gate with the expected outposts, preserving the cause", async () => {
      // A rejecting `outenvelopes` read propagates straight out of the poll —
      // the fast path through the same catch a timeout takes.
      const ctx = externalContext(),
        cause = new Error("outenvelopes read failed")
      Object.defineProperty(ctx, "wire", {
        get: () => ({
          getChains: async () => ({
            rows: [
              chainRow(DepotChainCode, true),
              chainRow(EthereumChainCode, false)
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
      ).resolves.toContain(String(EthereumChainCode))
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
      expect(
        Steps.externalOutpost.OutboundEnvelopesTimeoutMs
      ).toBeGreaterThan(Steps.externalOutpost.OutboundEnvelopesPollBudgetMs)
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
