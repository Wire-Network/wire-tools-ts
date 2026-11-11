import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  AWSAccountName,
  findKeyMaterial,
  isKMSCustodied,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type ClusterSignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { KeySteps } from "@wireio/cluster-tool/orchestration/steps/KeySteps"
import { BatchOperatorKeyTool } from "@wireio/cluster-tool/tools/wire/BatchOperatorKeyTool"
import type { KeyPair } from "@wireio/cluster-tool/types"
import {
  ethereumKeyPairFromKmsPublicKey,
  ethereumKeyPairFromWallet,
  keyPairFromPrivate
} from "@wireio/cluster-tool/utils"

/** Every region the SSM parameters replicate to; the KMS keys live in the first. */
const Regions = ["us-east-1", "eu-west-1"],
  KmsRegion = Regions[0],
  SecretIdPattern = "/wire/{cluster}/{account}/{keyType}",
  KmsAliasPattern = "alias/wire/{cluster}/{account}/{keyType}"

/** The bootstrap labels the tool pre-creates for. */
const Labels = ["batchop.a", "batchop.b"]

/** Per-fixture custody shape. */
interface SettingsOptions {
  kms?: boolean
  policy?: SignatureProviderKeyPolicy
}

/** The resolved key-custody settings for `type`, optionally with kms and a policy. */
function settings(
  type: ClusterSignatureProviderType = SignatureProviderType.SSM,
  { kms = false, policy = SignatureProviderKeyPolicy.adoptOrCreate }: SettingsOptions = {}
): KeyCustodySettings {
  return {
    signatureProvider: {
      type,
      ssm:
        type === SignatureProviderType.SSM
          ? { awsRegions: Regions, awsSecretIdPattern: SecretIdPattern }
          : null,
      kms: kms ? { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion } : null,
      batchOperatorKeyPolicy: policy
    },
    awsClusterNodeConfig: {
      account: AWSAccountName.dev,
      regions: Regions,
      ssm: null,
      kms: null
    }
  }
}

/**
 * A REAL random pair of `keyType` for `account`, in the custody form the
 * bootstrap's seam would hand back under `custody`: material for every SSM
 * curve, a material-less KMS reference for a KMS-custodied EM.
 */
function fakePair(
  custody: KeyCustodySettings,
  keyType: KeyType,
  account: string
): KeyPair {
  if (keyType === KeyType.EM) {
    const wallet = ethers.Wallet.createRandom()
    return isKMSCustodied(custody.signatureProvider, KeyType.EM)
      ? ethereumKeyPairFromKmsPublicKey(
          ethers.getBytes(
            ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
          ),
          KmsRegion,
          ClusterConfigProvider.custodySource(custody, account, KeyType.EM).awsKmsKeyId
        )
      : ethereumKeyPairFromWallet(wallet)
  }
  return keyPairFromPrivate(keyType, PrivateKey.generate(keyType).toNativeString())
}

describe("BatchOperatorKeyTool", () => {
  let adopt: jest.SpyInstance, publish: jest.SpyInstance

  beforeEach(() => {
    adopt = jest
      .spyOn(KeySteps, "adoptOrCreateSignatureProviderKey")
      .mockImplementation(
        (async (custody: KeyCustodySettings, keyType: KeyType, account: string) =>
          fakePair(custody, keyType, account)) as never
      )
    publish = jest
      .spyOn(KeySteps, "publishSignatureProviderKey")
      .mockResolvedValue(undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  describe("adoptOrCreate", () => {
    it("refuses a KEY / KIOD provider — there is no custody store to create into", async () => {
      await expect(
        BatchOperatorKeyTool.adoptOrCreate(
          settings(SignatureProviderType.KEY),
          Labels,
          KeyGenerator.context()
        )
      ).rejects.toThrow(
        /pre-creating keys requires an SSM signature provider \(got KEY\) — a KEY \/ KIOD cluster has no custody store/
      )
      await expect(
        BatchOperatorKeyTool.adoptOrCreate(
          settings(SignatureProviderType.KIOD),
          Labels,
          KeyGenerator.context()
        )
      ).rejects.toThrow(/\(got KIOD\)/)
      expect(adopt).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    })

    it("refuses a label that is not a bootstrap batch operator's, before touching any key", async () => {
      await expect(
        BatchOperatorKeyTool.adoptOrCreate(
          settings(),
          [...Labels, "uwrit.a"],
          KeyGenerator.context()
        )
      ).rejects.toThrow(
        /"uwrit\.a" is not a bootstrap batch-operator label \(batchop\.<letter>\)/
      )
      expect(adopt).not.toHaveBeenCalled()
    })

    it("obtains wire K1 + solana ED + ethereum EM for every label, in label order, through the bootstrap's seam", async () => {
      const custody = settings(),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          Labels,
          KeyGenerator.context()
        )
      expect(BatchOperatorKeyTool.KeyTypes).toEqual([KeyType.K1, KeyType.EM, KeyType.ED])
      expect(adopt).toHaveBeenCalledTimes(Labels.length * 3)
      Labels.forEach(label => {
        const requested = adopt.mock.calls
          .filter(([, , account]) => account === label)
          .map(([, keyType]) => keyType)
        expect(new Set(requested)).toEqual(new Set([KeyType.K1, KeyType.ED, KeyType.EM]))
        // The purpose names the operator and the curve's role.
        adopt.mock.calls
          .filter(([, , account]) => account === label)
          .forEach(([, keyType, , keyContext, options]) => {
            expect(keyContext).toEqual(KeyGenerator.context())
            expect(options.purpose).toContain(`batch operator ${label}`)
            expect(options.purpose).toContain(`(${KeyType[keyType]})`)
          })
      })
      expect(operators.map(operator => operator.label)).toEqual(Labels)
      operators.forEach(operator => {
        expect(operator).toMatchObject({
          publicationLabel: operator.label,
          account: operator.label,
          type: OperatorType.BATCH
        })
        expect(operator.wire.type).toBe(KeyType.K1)
        expect(operator.ethereum.type).toBe(KeyType.EM)
        expect(operator.solana.type).toBe(KeyType.ED)
        expect(operator.wireFinalizer).toBeUndefined()
      })
    })

    it("publishes every SSM-custodied curve through the SAME publish primitive, with the key the identity holds", async () => {
      const custody = settings(),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          Labels,
          KeyGenerator.context()
        )
      expect(publish).toHaveBeenCalledTimes(Labels.length * 3)
      operators.forEach(operator => {
        const published = publish.mock.calls.filter(
          ([publication]) => publication.label === operator.label
        )
        expect(published.map(([publication]) => publication)).toEqual(
          KeySteps.operatorKeyPublications(custody, operator.label, OperatorType.BATCH)
        )
        published.forEach(([publication, privateKey]) => {
          expect(publication.awsRegions).toEqual(Regions)
          expect(privateKey).toBe(
            KeySteps.identityPrivateKey(operator, publication.keyType, operator.label)
          )
        })
      })
    })

    it("publishes ONLY the SSM-custodied curves under kms — the EM key has no parameter to put", async () => {
      const custody = settings(SignatureProviderType.SSM, { kms: true }),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          Labels,
          KeyGenerator.context()
        )
      expect(publish).toHaveBeenCalledTimes(Labels.length * 2)
      expect(
        new Set(publish.mock.calls.map(([publication]) => publication.keyType))
      ).toEqual(new Set([KeyType.K1, KeyType.ED]))
      operators.forEach(operator => {
        expect(operator.ethereum.awsKmsKeyId).toBe(
          `alias/wire/dev/${operator.label.replace(".", "-")}/EM`
        )
        expect(operator.ethereum).not.toHaveProperty("privateKey")
      })
    })

    it("forces the policy to adoptOrCreate even when the settings say adoptOnly — this command IS the pre-creation", async () => {
      const custody = settings(SignatureProviderType.SSM, {
        kms: true,
        policy: SignatureProviderKeyPolicy.adoptOnly
      })
      await BatchOperatorKeyTool.adoptOrCreate(custody, Labels, KeyGenerator.context())
      expect(adopt).toHaveBeenCalled()
      adopt.mock.calls.forEach(([creating]: [KeyCustodySettings]) => {
        expect(creating.signatureProvider.batchOperatorKeyPolicy).toBe(
          SignatureProviderKeyPolicy.adoptOrCreate
        )
        // Nothing else is rewritten.
        expect(creating.signatureProvider.type).toBe(SignatureProviderType.SSM)
        expect(creating.signatureProvider.kms).toEqual(custody.signatureProvider.kms)
        expect(creating.awsClusterNodeConfig).toBe(custody.awsClusterNodeConfig)
      })
      // The caller's settings are never mutated.
      expect(custody.signatureProvider.batchOperatorKeyPolicy).toBe(
        SignatureProviderKeyPolicy.adoptOnly
      )
    })
  })

  describe("toListing", () => {
    it("lists 3 PUBLIC rows per operator (K1, EM, ED) — the EM row carrying its address — with SSM / KMS custody references", async () => {
      const custody = settings(SignatureProviderType.SSM, { kms: true }),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          Labels,
          KeyGenerator.context()
        ),
        listing = BatchOperatorKeyTool.toListing(custody, operators)
      expect(listing).toHaveLength(Labels.length * 3)
      expect(listing).toEqual(
        operators.flatMap(operator => [
          {
            label: operator.label,
            keyType: KeyType.K1,
            publicKey: operator.wire.publicKey,
            custody: `SSM:/wire/dev/${operator.label}/K1`
          },
          {
            label: operator.label,
            keyType: KeyType.EM,
            publicKey: operator.ethereum.publicKey,
            address: operator.ethereum.address,
            custody: `KMS:${KmsRegion}:alias/wire/dev/${operator.label.replace(".", "-")}/EM`
          },
          {
            label: operator.label,
            keyType: KeyType.ED,
            publicKey: operator.solana.publicKey,
            custody: `SSM:/wire/dev/${operator.label}/ED`
          }
        ])
      )
    })

    it("references the EM key's SSM parameter without kms", async () => {
      const custody = settings(),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          [Labels[0]],
          KeyGenerator.context()
        ),
        emRow = BatchOperatorKeyTool.toListing(custody, operators).find(
          row => row.keyType === KeyType.EM
        )
      expect(emRow.custody).toBe("SSM:/wire/dev/batchop.a/EM")
      expect(emRow.address).toBe(operators[0].ethereum.address)
    })

    it("carries NO secret — the document may be printed or committed", async () => {
      const custody = settings(),
        operators = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          Labels,
          KeyGenerator.context()
        ),
        serialized = JSON.stringify(BatchOperatorKeyTool.toListing(custody, operators))
      // The identities DO hold material (SSM curves) — none of it reaches the listing.
      operators.forEach(operator => {
        expect(operator.wire.privateKey).toMatch(/^PVT_K1_/)
        expect(serialized).not.toContain(operator.wire.privateKey)
        expect(serialized).not.toContain(operator.solana.privateKey)
        expect(serialized).not.toContain(operator.ethereum.privateKey)
      })
      expect(serialized).not.toContain("privateKey")
      expect(serialized).not.toContain("PVT_")
      expect(findKeyMaterial(serialized)).toEqual([])
    })

    it("refuses an identity missing one of its curves", async () => {
      const custody = settings(),
        [operator] = await BatchOperatorKeyTool.adoptOrCreate(
          custody,
          [Labels[0]],
          KeyGenerator.context()
        )
      expect(() =>
        BatchOperatorKeyTool.toListing(custody, [{ ...operator, solana: undefined }])
      ).toThrow(/batchop\.a has no ED key/)
    })
  })
})
