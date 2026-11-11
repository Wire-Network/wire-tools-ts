import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType, SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { BatchOperatorPrefundingSteps } from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  type ClusterBuildPhase
} from "@wireio/cluster-tool/orchestration"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import {
  BatchOperatorKeyTool,
  WireSyndicationTool
} from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal,
  { Actor } = Report,
  { SysioContractName } = SysioContracts,
  /** The three bootstrap batch operators. */
  Labels = Constants.batchOperatorLabels(3),
  /** A tooling-less generation context: K1 / ED / EM need no build. */
  keyContext = KeyGenerator.context()

afterEach(() => jest.restoreAllMocks())

describe("BatchOperatorPrefundingSteps", () => {
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "prefunding-steps-"))
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  /** A REAL context over the sandbox, its key store seeded with the persisted identities. */
  async function seededContext() {
    const ctx = fixtureContext({ dataPath }),
      operators = await BatchOperatorKeyTool.createPersisted(
        dataPath,
        Labels,
        keyContext
      )
    operators.forEach(operator => ctx.keyStore.setOperator(operator))
    return { ctx, operators }
  }

  it("names the two pre-funded shadows, one per outpost", () => {
    expect(BatchOperatorPrefundingSteps.PrefundedTokenCodes).toEqual([
      "LIQETH",
      "LIQSOL"
    ])
  })

  it("plans the three verify phases with one Step per operator, in label order", () => {
    const cluster = ClusterBuild.forContext(fixtureContext())
    BatchOperatorPrefundingSteps.planVerifyAdoptedIdentities(
      cluster,
      "PrefundedIdentities",
      "adopted",
      {},
      Labels
    )
    BatchOperatorPrefundingSteps.planVerifyAuthexLinks(
      cluster,
      "PrefundedOperatorLinks",
      "linked",
      {},
      Labels
    )
    BatchOperatorPrefundingSteps.planVerifyShadowCredits(
      cluster,
      "PrefundedOperatorCredits",
      "credited",
      {},
      Labels,
      BatchOperatorPrefundingSteps.PrefundedTokenCodes
    )
    const phases = cluster.children as unknown as readonly ClusterBuildPhase[]
    expect(
      phases.map(phase => [phase.name, phase.steps.map(step => step.name)])
    ).toEqual([
      [
        "PrefundedIdentities",
        Labels.map(label => `verify-${label}-adopted-identity`)
      ],
      [
        "PrefundedOperatorLinks",
        Labels.map(label => `verify-${label}-authex-links`)
      ],
      [
        "PrefundedOperatorCredits",
        Labels.map(label => `verify-${label}-shadow-credit`)
      ]
    ])
    phases.forEach(phase =>
      phase.steps.forEach(step => expect(step.actor).toBe(Actor.BatchOperator))
    )
    expect(phases[0].steps[0].input).toEqual({
      kind: "BatchOperatorPrefundingSteps.OperatorInput",
      label: Labels[0]
    })
    expect(phases[0].steps[0].runner).toBe(
      BatchOperatorPrefundingSteps.runVerifyAdoptedIdentity
    )
    expect(phases[1].steps[0].runner).toBe(
      BatchOperatorPrefundingSteps.runVerifyAuthexLink
    )
    expect(phases[2].steps[2].input).toEqual({
      kind: "BatchOperatorPrefundingSteps.ShadowCreditInput",
      label: Labels[2],
      tokenCodes: ["LIQETH", "LIQSOL"]
    })
    expect(phases[2].steps[2].runner).toBe(
      BatchOperatorPrefundingSteps.runVerifyShadowCredit
    )
  })

  describe("runVerifyAdoptedIdentity", () => {
    const step = (label: string) =>
      BatchOperatorPrefundingSteps.planVerifyAdoptedIdentity(
        Actor.BatchOperator,
        `verify-${label}`,
        "adopted",
        {},
        label
      )

    it("passes when the key store holds the persisted identity, and records its public halves", async () => {
      const { ctx, operators } = await seededContext(),
        recorder = new StepExtraRecorder(),
        verify = step(Labels[0])
      await StepExtraRecorder.runWith(recorder, () =>
        verify.runner(ctx, verify.input, signal)
      )
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          kind: "note",
          label: Labels[0],
          wire: operators[0].wire.publicKey,
          ethereum: operators[0].ethereum.address,
          solana: operators[0].solana.publicKey
        })
      )
      expect(JSON.stringify(recorder.calls)).not.toContain(
        operators[0].wire.privateKey
      )
    })

    it("fails naming the curve when the key store holds a regenerated key", async () => {
      const { ctx, operators } = await seededContext(),
        [held] = operators,
        regenerated = await KeyGenerator.create(KeyType.EM, keyContext)
      ctx.keyStore.setOperator({ ...held, ethereum: regenerated })
      const verify = step(Labels[0])
      await expect(verify.runner(ctx, verify.input, signal)).rejects.toThrow(
        /batchop\.a's Ethereum key was regenerated instead of adopted/
      )
    })

    it("fails when the key store never received the operator", async () => {
      await BatchOperatorKeyTool.createPersisted(dataPath, Labels, keyContext)
      const verify = step(Labels[1])
      await expect(
        verify.runner(fixtureContext({ dataPath }), verify.input, signal)
      ).rejects.toThrow(/has not been provisioned/)
    })
  })

  describe("runVerifyAuthexLink", () => {
    const step = (label: string) =>
      BatchOperatorPrefundingSteps.planVerifyAuthexLink(
        Actor.BatchOperator,
        `verify-${label}`,
        "linked",
        {},
        label
      )

    /** Mock the authex links table read with `rows` (`key` / `username` / `pub_key`). */
    function mockLinks(
      ctx: ReturnType<typeof fixtureContext>,
      rows: readonly SysioContracts.SysioAuthexLinksSType[]
    ): void {
      const contract = ctx.wire.getSysioContract(SysioContractName.authex)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
      jest.spyOn(contract.tables.links, "queryAll").mockResolvedValue([...rows])
    }

    /** A links row of `username` carrying `pubKey` on `chainKind`. */
    const row = (
      key: number,
      username: string,
      chainKind: SysioContracts.SysioAuthexChainkind,
      pubKey: string
    ): SysioContracts.SysioAuthexLinksSType => ({
      key,
      username,
      chain_kind: chainKind,
      pub_key: pubKey
    })
    const { CHAIN_KIND_EVM, CHAIN_KIND_SVM } = SysioContracts.SysioAuthexChainkind

    it("passes when both outpost keys are linked under the operator's account", async () => {
      const { ctx, operators } = await seededContext(),
        [operator] = operators
      mockLinks(ctx, [
        row(1, operator.account, CHAIN_KIND_EVM, operator.ethereum.publicKey),
        row(2, "someone.else", CHAIN_KIND_SVM, operators[1].solana.publicKey),
        row(3, operator.account, CHAIN_KIND_SVM, operator.solana.publicKey)
      ])
      const verify = step(operator.label)
      await expect(
        verify.runner(ctx, verify.input, signal)
      ).resolves.toBeUndefined()
    })

    it("fails naming the chain whose key is not linked", async () => {
      const { ctx, operators } = await seededContext(),
        [operator] = operators
      mockLinks(ctx, [
        row(1, operator.account, CHAIN_KIND_EVM, operator.ethereum.publicKey)
      ])
      const verify = step(operator.label)
      await expect(verify.runner(ctx, verify.input, signal)).rejects.toThrow(
        /has no sysio\.authex link for its Solana key/
      )
      // A link under ANOTHER account does not count for this operator.
      mockLinks(ctx, [
        row(1, "someone.else", CHAIN_KIND_EVM, operator.ethereum.publicKey),
        row(2, operator.account, CHAIN_KIND_SVM, operator.solana.publicKey)
      ])
      await expect(verify.runner(ctx, verify.input, signal)).rejects.toThrow(
        /has no sysio\.authex link for its Ethereum key/
      )
    })
  })

  describe("runVerifyShadowCredit", () => {
    const step = (label: string, tokenCodes: readonly string[]) =>
      BatchOperatorPrefundingSteps.planVerifyShadowCredit(
        Actor.BatchOperator,
        `verify-${label}`,
        "credited",
        {},
        label,
        tokenCodes
      )

    it("passes when every named shadow balance is positive, recording them", async () => {
      const { ctx, operators } = await seededContext(),
        recorder = new StepExtraRecorder(),
        read = jest
          .spyOn(WireSyndicationTool, "readLiqBalance")
          .mockImplementation(async (_ctx, _account, tokenCode) =>
            tokenCode === "LIQETH" ? 4_000_000_000n : 4_000_000_001n
          ),
        verify = step(Labels[0], BatchOperatorPrefundingSteps.PrefundedTokenCodes)
      await StepExtraRecorder.runWith(recorder, () =>
        verify.runner(ctx, verify.input, signal)
      )
      expect(read.mock.calls.map(([, account, tokenCode]) => [account, tokenCode])).toEqual([
        [operators[0].account, "LIQETH"],
        [operators[0].account, "LIQSOL"]
      ])
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          kind: "note",
          label: Labels[0],
          credits: [
            { tokenCode: "LIQETH", balance: "4000000000" },
            { tokenCode: "LIQSOL", balance: "4000000001" }
          ]
        })
      )
    })

    it("fails naming the shadow the operator holds none of", async () => {
      const { ctx } = await seededContext()
      jest
        .spyOn(WireSyndicationTool, "readLiqBalance")
        .mockImplementation(async (_ctx, _account, tokenCode) =>
          tokenCode === "LIQETH" ? 4_000_000_000n : 0n
        )
      const verify = step(Labels[2], BatchOperatorPrefundingSteps.PrefundedTokenCodes)
      await expect(verify.runner(ctx, verify.input, signal)).rejects.toThrow(
        /batchop\.c \(batchop\.c\) holds no LIQSOL/
      )
    })

    it("refuses a credit check that names no shadow", async () => {
      const { ctx } = await seededContext(),
        verify = step(Labels[0], [])
      await expect(verify.runner(ctx, verify.input, signal)).rejects.toThrow(
        /names no shadow/
      )
    })
  })
})
