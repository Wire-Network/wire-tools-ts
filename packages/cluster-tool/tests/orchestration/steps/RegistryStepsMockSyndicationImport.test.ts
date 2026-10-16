import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType, PublicKey } from "@wireio/sdk-core"
import {
  ClusterBuild,
  ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import {
  Steps,
  SyndicationUserSteps
} from "@wireio/cluster-tool/orchestration/steps"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool/Constants"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

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

  it("always types the verify Step's input, with no operators when none underwrites", () => {
    const phase = RegistrySteps.planMockSyndicationImport(
      ClusterBuild.forContext(context),
      "import",
      "import",
      {}
    )
    expect(phase.steps.at(-1).input).toEqual({
      kind: "RegistrySteps.VerifyMockSyndicationImportInput",
      batchOperatorLabels: []
    })
  })

  it("selects the one import credit template per key type", () => {
    expect(RegistrySteps.assertImportCredit(KeyType.ED)).toBe(
      RegistrySteps.MockSyndicationImportCredits[0]
    )
    expect(RegistrySteps.assertImportCredit(KeyType.EM).token_code).toBe(
      "LIQETH"
    )
    expect(() => RegistrySteps.assertImportCredit(KeyType.K1 as never)).toThrow(
      "0 K1 credits"
    )
  })

  it("funds operators from the ED-keyed (LIQSOL) template", () => {
    expect(RegistrySteps.MockBatchOperatorUnderwritingPair).toEqual(
      expect.objectContaining({
        chain_code: "SOLANA",
        token_code: "LIQSOL",
        keyType: KeyType.ED,
        amount: RegistrySteps.MockSyndicationImportAmount
      })
    )
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

  describe("batch-operator underwriting credits", () => {
    const labels = ["batchop.a", "batchop.b"]

    /** Seed the operators the credits are imported for. */
    function seedOperators() {
      labels.forEach(label =>
        context.keyStore.setOperator(
          fixtureOperatorAccount(label, OperatorType.BATCH)
        )
      )
    }

    it("grants each operator RAM by one node-owner addpolicy for its generated account", async () => {
      seedOperators()
      const phase = RegistrySteps.planBatchOperatorUnderwritingResources(
        ClusterBuild.forContext(context),
        "resources",
        "resources",
        {},
        labels
      )
      expect(phase.steps.map(step => step.name)).toEqual(
        labels.map(label => `underwriting-ram-${label}`)
      )
      expect(phase.steps.map(step => step.input)).toEqual(
        labels.map(label => ({
          kind: "RegistrySteps.BatchOperatorResourcesInput",
          label
        }))
      )
      expect(
        RegistrySteps.planBatchOperatorUnderwritingResource(
          Report.Actor.Sysio,
          "one",
          "one",
          {},
          "batchop.a"
        ).runner
      ).toBe(RegistrySteps.runBatchOperatorUnderwritingResources)
      const write = jest
        .spyOn(SyndicationUserSteps, "runResourcePolicy")
        .mockResolvedValue(undefined)
      await phase.steps[1].runner(context, phase.steps[1].input, signal)
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][1].data).toEqual({
        owner: context.keyStore.assertOperator("batchop.b").account,
        issuer: Constants.BOOTSTRAP_NODE_OWNER,
        net_weight: "0.0000 SYS",
        cpu_weight: "0.0000 SYS",
        ram_weight: RegistrySteps.BatchOperatorUnderwritingRamWeight,
        time_block: 0,
        network_gen: 0
      })
      await expect(
        RegistrySteps.runBatchOperatorUnderwritingResources(
          context,
          {
            kind: "RegistrySteps.BatchOperatorResourcesInput",
            label: "nobody"
          },
          signal
        )
      ).rejects.toThrow()
      expect(write).toHaveBeenCalledTimes(1)
    })

    it("plans one credit per operator after the bonder's and before the seal", () => {
      const phase = RegistrySteps.planMockSyndicationImport(
        ClusterBuild.forContext(context),
        "import",
        "import",
        {},
        labels
      )
      expect(phase.steps.map(step => step.runner)).toEqual([
        RegistrySteps.runMockSyndicationBonder,
        RegistrySteps.runMockSyndicationCredit,
        RegistrySteps.runMockSyndicationCredit,
        RegistrySteps.runBatchOperatorSyndicationCredit,
        RegistrySteps.runBatchOperatorSyndicationCredit,
        SyndContractSteps.runImportdone,
        RegistrySteps.runVerifyMockSyndicationImport
      ])
      expect(phase.steps[3].input).toEqual({
        kind: "RegistrySteps.BatchOperatorCreditInput",
        label: "batchop.a"
      })
      expect(phase.steps[6].input).toEqual({
        kind: "RegistrySteps.VerifyMockSyndicationImportInput",
        batchOperatorLabels: labels
      })
    })

    it("imports the LIQSOL credit to the operator's own ED key in one action", async () => {
      seedOperators()
      const write = jest
        .spyOn(SyndContractSteps, "runImportsynd")
        .mockResolvedValue(undefined)
      await RegistrySteps.runBatchOperatorSyndicationCredit(
        context,
        { kind: "RegistrySteps.BatchOperatorCreditInput", label: "batchop.b" },
        signal
      )
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][1].data).toEqual({
        chain_code: "SOLANA",
        token_code: "LIQSOL",
        credits: [
          {
            pubkey: PublicKey.from(
              context.keyStore.assertOperator("batchop.b").solana.publicKey
            ).data.hexString,
            amount: RegistrySteps.MockBatchOperatorUnderwritingPair.amount
          }
        ]
      })
      await expect(
        RegistrySteps.runBatchOperatorSyndicationCredit(
          context,
          { kind: "RegistrySteps.BatchOperatorCreditInput", label: "nobody" },
          signal
        )
      ).rejects.toThrow()
      expect(write).toHaveBeenCalledTimes(1)
    })

    it.each([
      [
        "liquid in the linked account",
        0n,
        BigInt(RegistrySteps.MockBatchOperatorUnderwritingPair.amount),
        true
      ],
      [
        "parked for the link to sweep",
        BigInt(RegistrySteps.MockBatchOperatorUnderwritingPair.amount),
        0n,
        true
      ],
      ["short", 0n, 1n, false],
      [
        "split between parked and liquid",
        1n,
        BigInt(RegistrySteps.MockBatchOperatorUnderwritingPair.amount) - 1n,
        false
      ]
    ])(
      "verifies each operator's credit: %s",
      async (_label, parked, liquid, passes) => {
        seedOperators()
        await RegistrySteps.runMockSyndicationBonder(
          context,
          RegistrySteps.planMockSyndicationBonder(
            Report.Actor.Sysio,
            "b",
            "b",
            {}
          ).input,
          signal
        )
        const bonderKeys = [
          RegistrySteps.readMockSyndicationBonder(context).solana.publicKey,
          RegistrySteps.readMockSyndicationBonder(context).ethereum.publicKey
        ].map(key => PublicKey.from(key).data.hexString)
        jest
          .spyOn(WireSyndicationTool, "readParked")
          .mockImplementation(async (_ctx, tokenCode, chainKind, pubkey) =>
            bonderKeys.includes(pubkey)
              ? {
                  token_code: tokenCode,
                  chain_kind: chainKind,
                  pubkey,
                  balance: RegistrySteps.MockSyndicationImportAmount,
                  position: { index_checkpoint: "0", owed_wire: "0" }
                }
              : parked === 0n
                ? undefined
                : {
                    token_code: tokenCode,
                    chain_kind: chainKind,
                    pubkey,
                    balance: parked.toString(),
                    position: { index_checkpoint: "0", owed_wire: "0" }
                  }
          )
        const balance = jest
          .spyOn(WireSyndicationTool, "readLiqBalance")
          .mockResolvedValue(liquid)
        jest.spyOn(WireSyndicationTool, "readMismatches").mockResolvedValue([])
        const step = RegistrySteps.planVerifyMockSyndicationImport(
            Report.Actor.Sysio,
            "verify",
            "verify",
            {},
            labels
          ),
          result = step.runner(context, step.input, signal)
        if (passes) {
          await result
          expect(balance).toHaveBeenCalledTimes(labels.length)
          expect(balance).toHaveBeenCalledWith(
            context,
            context.keyStore.assertOperator("batchop.a").account,
            "LIQSOL"
          )
        } else await expect(result).rejects.toThrow("mock syndication import")
      }
    )
  })
})
