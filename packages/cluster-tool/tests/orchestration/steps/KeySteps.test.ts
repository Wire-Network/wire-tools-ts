import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const mockSend = jest.fn()
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
}))

/** The captured input of the single command sent for the last call. */
function lastCommandInput(): Record<string, unknown> {
  return mockSend.mock.calls[0][0].input as Record<string, unknown>
}

describe("Steps.keys", () => {
  it.each(["planGenerateNodeKeys", "planCreateWallet"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.keys[factoryName](
        Report.Actor.Sysio,
        factoryName,
        `key step ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )

  describe("signatureProviderKeyPublications", () => {
    const config = fixtureConfig({
        clusterPath: "/tmp/wire-cluster-pubs",
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: {
            awsRegion: "us-east-1",
            awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
          }
        }
      }),
      publications = Steps.keys.signatureProviderKeyPublications(config)

    it("enumerates K1+BLS per producer node and K1+EM+ED per operator (bios excluded)", () => {
      // Fixture topology: 1 producer node (→ K1+BLS = 2) + (3 batch + 1
      // underwriter) operators × 3 (K1+EM+ED) = 12, total 14. A bios inclusion
      // would make it 16 — the count pins bios exclusion.
      expect(publications).toHaveLength(14)
    })

    it("renders each secret id from the pattern and carries NO key material", () => {
      const batchK1 = publications.find(
        publication =>
          publication.account === "batchop.a" &&
          publication.keyType === KeyType.K1
      )
      expect(batchK1?.secretId).toBe("/wire/wire-cluster-pubs/batchop.a/K1")
      expect(batchK1?.awsRegion).toBe("us-east-1")
      expect(batchK1).not.toHaveProperty("privateKey")
    })

    it("throws on a KEY provider (SSM settings required)", () => {
      expect(() =>
        Steps.keys.signatureProviderKeyPublications(fixtureConfig())
      ).toThrow(/SSM signature provider requires ssm settings/)
    })
  })

  describe("planSignatureProviderKeyPublications", () => {
    const config = fixtureConfig({
      clusterPath: "/tmp/wire-cluster-pubs",
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegion: "us-east-1",
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        }
      }
    })

    /** A registered orchestration child as the fake parent sees it (name only). */
    interface RegisteredChild {
      name: string
    }

    /** A minimal structural {@link ClusterBuildParent} capturing registrations. */
    function fixtureParent() {
      const children: RegisteredChild[] = [],
        parent = {
          context: fixtureContext(),
          push(...nodes: RegisteredChild[]) {
            children.push(...nodes)
            return parent
          }
        }
      return { parent, children }
    }

    it("composes the node-source phase: one step per producer-node key, self-registered", () => {
      const { parent, children } = fixtureParent()
      const phase = Steps.keys.planSignatureProviderKeyPublications(
        parent as never,
        "PublishNodeSignatureProviderKeys",
        "publish node keys",
        {},
        config,
        Steps.keys.SignatureKeySource.node
      )
      expect(children).toContain(phase)
      expect(phase.name).toBe("PublishNodeSignatureProviderKeys")
      // 1 producer node × (K1 + BLS) — operator publications are filtered OUT.
      expect(phase.steps.map(step => step.name)).toEqual([
        "publish-node_00-K1",
        "publish-node_00-BLS"
      ])
    })

    it("composes the operator-source phase: one step per operator key", () => {
      const { parent } = fixtureParent()
      const phase = Steps.keys.planSignatureProviderKeyPublications(
        parent as never,
        "PublishOperatorSignatureProviderKeys",
        "publish operator keys",
        {},
        config,
        Steps.keys.SignatureKeySource.operator
      )
      // (3 batch + 1 underwriter) × (K1 + EM + ED) = 12; no node publications.
      expect(phase.steps).toHaveLength(12)
      expect(
        phase.steps.every(step => !step.name.startsWith("publish-node_"))
      ).toBe(true)
    })
  })

  describe("runPublishSignatureProviderKey (jest SSM mock — no live AWS)", () => {
    beforeEach(() => mockSend.mockReset())

    it("PutParameters the operator K1 key's NATIVE string (WIF, not PVT_K1_)", async () => {
      mockSend.mockResolvedValueOnce({})
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "batchop.a",
        account: "batchop.a",
        type: OperatorType.BATCH,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        }
      })
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-batchop.a-K1",
        "publish batchop.a K1",
        {},
        {
          source: Steps.keys.SignatureKeySource.operator,
          nodeIndex: 0,
          account: "batchop.a",
          keyType: KeyType.K1,
          awsRegion: "us-east-1",
          secretId: "/wire/c/batchop.a/K1"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(lastCommandInput()).toEqual({
        Name: "/wire/c/batchop.a/K1",
        Value: PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString(),
        Type: "SecureString",
        Overwrite: true
      })
      // K1 native = WIF — never the WIRE PVT_ form.
      expect(lastCommandInput().Value).not.toMatch(/^PVT_/)
    })

    it("PutParameters the operator ED key's NATIVE string (base58 64-byte secret)", async () => {
      mockSend.mockResolvedValueOnce({})
      const ed = PrivateKey.generate(KeyType.ED)
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        account: "batchop.a",
        type: OperatorType.BATCH,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        },
        solana: {
          type: KeyType.ED,
          publicKey: ed.toPublic().toString(),
          privateKey: ed.toString()
        }
      })
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-batchop.a-ED",
        "publish batchop.a ED",
        {},
        {
          source: Steps.keys.SignatureKeySource.operator,
          nodeIndex: 0,
          account: "batchop.a",
          keyType: KeyType.ED,
          awsRegion: "us-east-1",
          secretId: "/wire/c/batchop.a/ED"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(lastCommandInput().Value).toBe(ed.toNativeString())
      expect(lastCommandInput().Value).not.toMatch(/^PVT_/)
    })

    it("PutParameters a producer-node BLS key's NATIVE string (PVT_BLS_ IS native)", async () => {
      mockSend.mockResolvedValueOnce({})
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          k1: {
            type: KeyType.K1,
            publicKey: Constants.DEV_K1_PUBLIC_KEY,
            privateKey: Constants.DEV_K1_PRIVATE_KEY
          },
          bls: {
            type: KeyType.BLS,
            publicKey: Constants.DEV_BLS_PUBLIC_KEY,
            privateKey: Constants.DEV_BLS_PRIVATE_KEY,
            proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
          }
        }
      })
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-node_00-BLS",
        "publish node_00 BLS",
        {},
        {
          source: Steps.keys.SignatureKeySource.node,
          nodeIndex: 0,
          account: "node_00",
          keyType: KeyType.BLS,
          awsRegion: "us-east-1",
          secretId: "/wire/c/node_00/BLS"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(lastCommandInput()).toEqual({
        Name: "/wire/c/node_00/BLS",
        Value: PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString(),
        Type: "SecureString",
        Overwrite: true
      })
      // BLS is the one type whose WIRE string IS its native form.
      expect(lastCommandInput().Value).toMatch(/^PVT_BLS_/)
    })
  })
})
