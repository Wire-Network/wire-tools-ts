import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType, PublicKey } from "@wireio/sdk-core"
import {
  ClusterBuild,
  ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const RegistrySteps = Steps.registry
const SyndContractSteps = Steps.contracts.sysio.synd
const signal = new AbortController().signal

describe("RegistrySteps mock syndication import", () => {
  let context: ClusterBuildContext
  let dataPath: string
  beforeEach(() => {
    dataPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "mock-syndication-import-")
    )
    context = new ClusterBuildContext(
      { ...fixtureConfig(), dataPath },
      getLogger("mock-syndication-import-test")
    )
  })
  afterEach(() => {
    jest.restoreAllMocks()
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("plans bonder keys, two imports and importdone as distinct ordered Steps", () => {
    const phase = RegistrySteps.planMockSyndicationImport(
      ClusterBuild.forContext(context),
      "import",
      "import",
      {}
    )
    expect(phase.steps.map(step => step.runner)).toEqual([
      RegistrySteps.runMockSyndicationBonder,
      RegistrySteps.runMockSyndicationCredit,
      RegistrySteps.runMockSyndicationCredit,
      SyndContractSteps.runImportdone,
      RegistrySteps.runVerifyMockSyndicationImport
    ])
    expect(
      RegistrySteps.MockSyndicationImportCredits.map(input => [
        input.chain_code,
        input.token_code,
        input.amount
      ])
    ).toEqual([
      ["SOLANA", "LIQSOL", RegistrySteps.MockSyndicationImportAmount],
      ["ETHEREUM", "LIQETH", RegistrySteps.MockSyndicationImportAmount]
    ])
    expect(RegistrySteps.MockSyndicationImportAmount).toBe(100_000_000_000)
  })

  it("persists generated ED/EM keys under a durable bonder label and refuses replacement", async () => {
    const step = RegistrySteps.planMockSyndicationBonder(
      Report.Actor.Sysio,
      "bonder",
      "keys",
      {}
    )
    await step.runner(context, step.input, signal)
    const bonder = RegistrySteps.readMockSyndicationBonder(context),
      keypair = SolanaFundingTool.loadKeypair(
        dataPath,
        RegistrySteps.MockSyndicationBonderLabel
      )
    expect(bonder.solana.type).toBe(KeyType.ED)
    expect(bonder.ethereum.type).toBe(KeyType.EM)
    const reloaded = new ClusterBuildContext(
      { ...fixtureConfig(), dataPath },
      getLogger("bonder-reload-test")
    )
    expect(RegistrySteps.readMockSyndicationBonder(reloaded)).toEqual(bonder)
    expect(Buffer.from(keypair.publicKey.toBytes()).toString("hex")).toBe(
      PublicKey.from(bonder.solana.publicKey).data.hexString
    )
    expect(PublicKey.from(bonder.ethereum.publicKey).data.array).toHaveLength(
      33
    )
    await expect(step.runner(context, step.input, signal)).rejects.toThrow(
      "already exists"
    )
  })

  it.each(RegistrySteps.MockSyndicationImportCredits)(
    "imports $token_code using native public-key bytes and just one action",
    async input => {
      await RegistrySteps.runMockSyndicationBonder(
        context,
        RegistrySteps.planMockSyndicationBonder(
          Report.Actor.Sysio,
          "bonder",
          "bonder",
          {}
        ).input,
        signal
      )
      const write = jest
          .spyOn(SyndContractSteps, "runImportsynd")
          .mockResolvedValue(undefined),
        step = RegistrySteps.planMockSyndicationCredit(
          Report.Actor.Sysio,
          "credit",
          "credit",
          {},
          input
        )
      await step.runner(context, step.input, signal)
      const data = write.mock.calls[0][1].data
      expect(write).toHaveBeenCalledTimes(1)
      expect(data).toEqual({
        chain_code: input.chain_code,
        token_code: input.token_code,
        credits: [{ amount: input.amount, pubkey: expect.any(String) }]
      })
      expect(Buffer.from(data.credits[0].pubkey, "hex")).toHaveLength(
        input.keyType === KeyType.ED ? 32 : 33
      )
    }
  )

  it("verifies both imported positions and refuses a missing position", async () => {
    await RegistrySteps.runMockSyndicationBonder(
      context,
      RegistrySteps.planMockSyndicationBonder(
        Report.Actor.Sysio,
        "bonder",
        "bonder",
        {}
      ).input,
      signal
    )
    const read = jest
      .spyOn(WireSyndicationTool, "readParked")
      .mockImplementation(async (_ctx, tokenCode, chainKind, pubkey) => ({
        token_code: tokenCode,
        chain_kind: chainKind,
        pubkey,
        balance: RegistrySteps.MockSyndicationImportAmount,
        position: { index_checkpoint: "0", owed_wire: "0" }
      }))
    jest.spyOn(WireSyndicationTool, "readMismatches").mockResolvedValue([])
    const step = RegistrySteps.planVerifyMockSyndicationImport(
      Report.Actor.Sysio,
      "verify",
      "verify",
      {}
    )
    await step.runner(context, step.input, signal)
    expect(read).toHaveBeenCalledTimes(2)
    read.mockResolvedValue(undefined)
    await expect(step.runner(context, step.input, signal)).rejects.toThrow(
      "missing parked"
    )
  })

  it("refuses an unprovisioned bonder and cancellation before any import", async () => {
    const write = jest
        .spyOn(SyndContractSteps, "runImportsynd")
        .mockResolvedValue(undefined),
      input = RegistrySteps.MockSyndicationImportCredits[0]
    await expect(
      RegistrySteps.runMockSyndicationCredit(context, input, signal)
    ).rejects.toThrow("has not been provisioned")
    await expect(
      RegistrySteps.runMockSyndicationBonder(
        context,
        RegistrySteps.planMockSyndicationBonder(
          Report.Actor.Sysio,
          "bonder",
          "bonder",
          {}
        ).input,
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  })
})
