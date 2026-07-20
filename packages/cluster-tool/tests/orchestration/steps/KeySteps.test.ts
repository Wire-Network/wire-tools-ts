import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
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

  describe("runPublishSignatureProviderKey (jest SSM mock — no live AWS)", () => {
    beforeEach(() => mockSend.mockReset())

    it("reads the operator's private key from the key store and PutParameters it", async () => {
      mockSend.mockResolvedValueOnce({})
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        account: "batchop.a",
        type: OperatorType.BATCH,
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_a",
          privateKey: "PVT_K1_a"
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
        Value: "PVT_K1_a",
        Type: "SecureString",
        Overwrite: true
      })
    })

    it("reads a producer-node key from the key store by index", async () => {
      mockSend.mockResolvedValueOnce({})
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          k1: {
            type: KeyType.K1,
            publicKey: "PUB_K1_n0",
            privateKey: "PVT_K1_n0"
          },
          bls: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_n0",
            privateKey: "PVT_BLS_n0",
            proofOfPossession: "POP_n0"
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
        Value: "PVT_BLS_n0",
        Type: "SecureString",
        Overwrite: true
      })
    })
  })
})
