import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { KeySpec, KeyUsageType } from "@aws-sdk/client-kms"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey, PublicKey } from "@wireio/sdk-core"
import {
  AWSAccountName,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type AWSKMSSignatureProviderOptions,
  type ClusterConfig,
  type KMSCustodiedKeyType
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { NodeopProcess } from "@wireio/cluster-tool/cluster/processes"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import {
  ClusterConfigProvider,
  NodeConfig,
  NodeRole
} from "@wireio/cluster-tool/config"
import { KMSClientProvider } from "@wireio/cluster-tool/config/KMSClientProvider"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import type { WireFinalizerKeyPair } from "@wireio/cluster-tool/types/KeyPair"
import { ethereumPublicKeyFromWallet } from "@wireio/cluster-tool/utils"
import {
  fixtureConfig,
  fixtureProducerTopology,
  fixtureProducerTopologyOverrides
} from "../../config/clusterConfigFixture.js"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

/** The `SSMClient` constructor config — region-less means the ambient region. */
interface MockSSMClientConfig {
  region?: string
}

const mockSend = jest.fn()
// `send` is called with the command AND the region its client was constructed
// for: SSM parameters are per-region, so the store below can only mimic AWS if
// it knows which region a get/put is addressed to.
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest
    .fn()
    .mockImplementation(({ region }: MockSSMClientConfig = {}) => ({
      send: (command: unknown) => mockSend(command, region ?? "")
    })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
}))

/** The `KMSClient` constructor config — a KMS client is always regional. */
interface MockKMSClientConfig {
  region?: string
}

const mockKmsSend = jest.fn()
jest.mock("@aws-sdk/client-kms", () => ({
  // The SDK's own enum rosters — the provider reads `KeySpec` / `KeyUsageType` off the module.
  ...jest.requireActual("@aws-sdk/client-kms"),
  KMSClient: jest
    .fn()
    .mockImplementation(({ region }: MockKMSClientConfig = {}) => ({
      send: (command: unknown) => mockKmsSend(command, region ?? "")
    })),
  GetPublicKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetPublicKey", input })),
  CreateKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateKey", input })),
  CreateAliasCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateAlias", input }))
}))

/** A captured KMS tag. */
interface MockKmsTag {
  TagKey: string
  TagValue: string
}

/** The captured `GetPublicKey` / `CreateKey` / `CreateAlias` input. */
interface MockKmsCommandInput {
  KeyId?: string
  KeySpec?: string
  KeyUsage?: string
  Description?: string
  Tags?: MockKmsTag[]
  AliasName?: string
  TargetKeyId?: string
}

/** The shape the mocked `@aws-sdk/client-kms` command constructors produce. */
interface MockKmsCommand {
  kind: string
  input: MockKmsCommandInput
}

/**
 * One key the in-memory KMS holds: its ARN, its curve, and the LOCAL key whose
 * point it reports — an ethers wallet for a secp256k1 (K1 / EM) key, a web3
 * keypair for an Ed25519 (ED) key.
 */
interface MockKmsKey {
  arn: string
  keyType: KMSCustodiedKeyType
  wallet?: ethers.HDNodeWallet
  keypair?: Keypair
}

/** Every KMS command of `kind` that was sent, in order, with its input. */
function kmsCommandInputs(kind: string): MockKmsCommandInput[] {
  return mockKmsSend.mock.calls
    .map(([command]: [MockKmsCommand]) => command)
    .filter(command => command.kind === kind)
    .map(command => command.input)
}

/** KMS's not-found rejection — the ONLY failure the adopt probe treats as absence. */
function kmsNotFound(keyId: string): Error {
  return Object.assign(new Error(`Alias ${keyId} is not found.`), {
    name: "NotFoundException"
  })
}

/** The DER `SubjectPublicKeyInfo` prefix of a secp256k1 public key. */
const Secp256k1SpkiPrefix = "3056301006072a8648ce3d020106052b8104000a034200"

/** The DER SPKI KMS returns for a held key — RFC 8410 around the keypair's point for ED, secp256k1 around the wallet's for K1 / EM. */
function kmsSpki(key: MockKmsKey): Uint8Array {
  return key.keyType === KeyType.ED
    ? Uint8Array.of(
        ...KMSClientProvider.Ed25519SpkiPrefix,
        ...key.keypair.publicKey.toBytes()
      )
    : ethers.getBytes(
        `0x${Secp256k1SpkiPrefix}${key.wallet.signingKey.publicKey.slice(2)}`
      )
}

/** The KMS key spec a held key reports — K1 and EM share the secp256k1 spec. */
function kmsKeySpec(key: MockKmsKey): KeySpec {
  return key.keyType === KeyType.ED
    ? KeySpec.ECC_NIST_EDWARDS25519
    : KeySpec.ECC_SECG_P256K1
}

/**
 * A REAL in-memory KMS behind the mocked `send`, keyed by alias: `GetPublicKey`
 * answers for a bound alias and reports not-found otherwise; `CreateKey` mints a
 * key of the requested spec, `CreateAlias` binds it — so adopt → create →
 * read-back behaves like AWS. ONE region is enough: a KMS key is regional and
 * the cluster names exactly one.
 */
const kmsStore = new Map<string, MockKmsKey>()
let kmsPendingKey: MockKmsKey = null

/** Bind a secp256k1 key for `wallet` under `aliasName` — the adopt-existing case. */
function seedKmsKey(aliasName: string, wallet = ethers.Wallet.createRandom()): MockKmsKey {
  const key: MockKmsKey = {
    arn: `arn:aws:kms:us-east-1:123456789012:key/${kmsStore.size + 1}`,
    keyType: KeyType.EM,
    wallet
  }
  kmsStore.set(aliasName, key)
  return key
}

/** Bind an Ed25519 key for `keypair` under `aliasName` — the adopt-existing case of an ED key. */
function seedKmsSolanaKey(aliasName: string, keypair = Keypair.generate()): MockKmsKey {
  const key: MockKmsKey = {
    arn: `arn:aws:kms:us-east-1:123456789012:key/${kmsStore.size + 1}`,
    keyType: KeyType.ED,
    keypair
  }
  kmsStore.set(aliasName, key)
  return key
}

/** Bind a secp256k1 key for `wallet` under `aliasName` as a WIRE K1 key — the adopt-existing case of a batch operator's account key. */
function seedKmsWireKey(aliasName: string, wallet = ethers.Wallet.createRandom()): MockKmsKey {
  const key: MockKmsKey = {
    arn: `arn:aws:kms:us-east-1:123456789012:key/${kmsStore.size + 1}`,
    keyType: KeyType.K1,
    wallet
  }
  kmsStore.set(aliasName, key)
  return key
}

function installKMSStoreMock(): void {
  mockKmsSend.mockImplementation(async (command: MockKmsCommand, region: string) => {
    if (command.kind === "GetPublicKey") {
      const key = kmsStore.get(command.input.KeyId)
      if (key == null) throw kmsNotFound(command.input.KeyId)
      return {
        KeyId: key.arn,
        PublicKey: kmsSpki(key),
        KeySpec: kmsKeySpec(key),
        KeyUsage: KeyUsageType.SIGN_VERIFY
      }
    }
    if (command.kind === "CreateKey") {
      const arn = `arn:aws:kms:${region}:123456789012:key/${kmsStore.size + 1}`
      kmsPendingKey =
        command.input.KeySpec === KeySpec.ECC_NIST_EDWARDS25519
          ? { arn, keyType: KeyType.ED, keypair: Keypair.generate() }
          : { arn, keyType: KeyType.EM, wallet: ethers.Wallet.createRandom() }
      return { KeyMetadata: { Arn: kmsPendingKey.arn } }
    }
    kmsStore.set(command.input.AliasName, kmsPendingKey)
    return {}
  })
}

/** A captured SSM tag. */
interface MockTag {
  Key: string
  Value: string
}

/** The captured `GetParameter` / `PutParameter` input. */
interface MockCommandInput {
  Name: string
  Value?: string
  Type?: string
  Overwrite?: boolean
  WithDecryption?: boolean
  Tags?: MockTag[]
}

/** The shape the mocked `@aws-sdk/client-ssm` command constructors produce. */
interface MockCommand {
  kind: string
  input: MockCommandInput
}

/** Every command of `kind` that was sent, in order, with its input. */
function commandInputs(kind: string): MockCommandInput[] {
  return mockSend.mock.calls
    .map(([command]: [MockCommand]) => command)
    .filter(command => command.kind === kind)
    .map(command => command.input)
}

/** An AWS SDK service exception — identified by its `name`, as the SDK does. */
function parameterNotFound(name: string): Error {
  return Object.assign(new Error(`Parameter ${name} not found.`), {
    name: "ParameterNotFound"
  })
}

/** A resolved `GetParameter` response carrying `value`. */
function secureStringResponse(value: string): Record<string, unknown> {
  return { Parameter: { Type: "SecureString", Value: value } }
}

/** Every key is replicated to EVERY region — no primary. */
const SSMRegions = ["us-east-1", "eu-west-1"]

/** The genesis `initial_timestamp` a rendered nodeop argv is resolved against. */
const GenesisTimestamp = "2026-01-01T00:00:00.000"

/**
 * Back the mocked `send` with a REAL in-memory parameter store, so probe →
 * put → re-probe behaves like AWS regardless of the order concurrent key
 * generation happens to issue the commands in.
 *
 * Keyed by REGION then id, exactly as SSM is: a put into `us-east-1` leaves the
 * id UNPUBLISHED in `eu-west-1`, which is the whole reason publication probes
 * and writes per region rather than once per key.
 */
const ssmStore = new Map<string, Map<string, string>>()

/** The parameter map for `region`, created on first touch. */
function regionStore(region: string): Map<string, string> {
  const existing = ssmStore.get(region)
  if (existing != null) return existing
  const created = new Map<string, string>()
  ssmStore.set(region, created)
  return created
}

/** Seed `value` at `secretId` in EVERY region — the adopted-everywhere case. */
function publishEverywhere(secretId: string, value: string): void {
  SSMRegions.forEach(region => regionStore(region).set(secretId, value))
}

function installSSMStoreMock(): void {
  mockSend.mockImplementation(async (command: MockCommand, region: string) => {
    const parameters = regionStore(region)
    if (command.kind === "GetParameter") {
      const value = parameters.get(command.input.Name)
      if (value == null) throw parameterNotFound(command.input.Name)
      return secureStringResponse(value)
    }
    parameters.set(command.input.Name, command.input.Value)
    return {}
  })
}

/** `sys-util` output the fake binary prints for a BLS generation — the one backend that still shells out. */
const BLS_OUTPUT =
  `Private key: ${Constants.DEV_BLS_PRIVATE_KEY}\n` +
  `Public key: ${Constants.DEV_BLS_PUBLIC_KEY}\n` +
  `Proof of Possession: ${Constants.DEV_BLS_PROOF_OF_POSSESSION}`

describe("Steps.keys", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "key-steps-"))
    Fs.mkdirSync(Path.join(dir, "bin"), { recursive: true })
    fakeBinary(Path.join(dir, KeyGenerator.SysUtilSubpath), BLS_OUTPUT)
  })

  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    mockSend.mockReset()
    ssmStore.clear()
    mockKmsSend.mockReset()
    kmsStore.clear()
    kmsPendingKey = null
  })

  /** An executable shell script that prints `stdout` regardless of its args. */
  function fakeBinary(file: string, stdout: string): string {
    Fs.writeFileSync(file, `#!/bin/sh\ncat <<'KEYEOF'\n${stdout}\nKEYEOF\n`)
    Fs.chmodSync(file, 0o755)
    return file
  }

  /** A buildPath pointed at this suite's fake sys-util — K1 / ED / EM need no binary at all. */
  function fakeExecutables(): Partial<ClusterConfig> {
    return { buildPath: dir }
  }

  /** The generation context over the fake sys-util. */
  function keyContext(): KeyGenerator.Context {
    return KeyGenerator.context(dir)
  }

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

  /** The SSM provider + AWS placement: `{cluster}` renders the AWS ACCOUNT, not the dir. */
  function ssmOverrides(): Partial<ClusterConfig> {
    return {
      clusterPath: "/tmp/wire-cluster-pubs",
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegions: SSMRegions,
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        },
        kms: null,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.test,
        regions: SSMRegions,
        ssm: null,
        kms: null
      }
    }
  }

  /** An SSM cluster fixture (21 producers on ONE node — every account shares it). */
  function ssmConfig(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
    return fixtureConfig({ ...ssmOverrides(), ...overrides })
  }

  /**
   * The producer topologies every publication contract is pinned against, as
   * `[name, producerNodeCount, producerCount]`: each node hosting one producer,
   * one node hosting several, and both shapes in one cluster.
   */
  const ProducerTopologies: ReadonlyArray<readonly [string, number, number]> = [
    ["one producer per node", 2, 2],
    ["several producers on one node", 1, 3],
    ["mixed (node_00 hosts two, node_01 hosts one)", 2, 3]
  ]

  /** An SSM cluster fixture re-planned onto a producer topology. */
  function ssmTopologyConfig(
    producerNodeCount: number,
    producerCount: number
  ): ClusterConfig {
    return fixtureProducerTopology(producerNodeCount, producerCount, ssmOverrides())
  }

  /** The planned producer nodes of `config`, in plan order. */
  function producerNodesOf(config: ClusterConfig): NodeConfig[] {
    return NodeConfig.plan(config).filter(node => node.role === NodeRole.producer)
  }

  describe("signatureProviderKeyPublications", () => {
    const config = ssmConfig(),
      publications = Steps.keys.signatureProviderKeyPublications(config)

    it("enumerates the GENESIS identity, every producer ACCOUNT, and every operator — a SHARED node publishes nothing under its own name", () => {
      // Fixture topology: bios K1+BLS (2) + 21 producer ACCOUNTS × K1+BLS (42) + 3 batch
      // operators × 3 K1/EM/ED (9) = 53.
      //
      // All 21 accounts share ONE node, so each owns its finalizer key (a shared one would fail
      // `regfinkey`'s global uniqueness check), and BOTH halves of an account's set are
      // published under ITS label, because custody is per-identity — the K1 it shares with its
      // node is republished here rather than referenced across labels.
      const producerAccounts = producerNodesOf(config).flatMap(node => node.producers)
      expect(publications).toHaveLength(11 + producerAccounts.length * 2)
      producerNodesOf(config).forEach(node =>
        expect(
          publications.filter(
            publication => publication.publicationLabel === node.name
          )
        ).toEqual([])
      )
      producerAccounts.forEach(label => {
        const rows = publications.filter(publication => publication.label === label)
        expect(rows.map(publication => publication.keyType).sort()).toEqual(
          [KeyType.K1, KeyType.BLS].sort()
        )
        rows.forEach(publication => expect(publication.publicationLabel).toBe(label))
      })
    })

    it("publishes a node's SOLE producer under the NODE's name — the path a deployment fetches by node", () => {
      const topology = ssmTopologyConfig(2, 2),
        rows = Steps.keys
          .signatureProviderKeyPublications(topology)
          .filter(publication =>
            producerNodesOf(topology).some(node => node.producers.includes(publication.label))
          )
      expect(rows.map(publication => publication.secretId).sort()).toEqual(
        [
          "/wire/test/node_00/BLS",
          "/wire/test/node_00/K1",
          "/wire/test/node_01/BLS",
          "/wire/test/node_01/K1"
        ].sort()
      )
      // The key-store handle stays the producer — only the secret-id segment is the node's.
      expect(rows.map(publication => publication.label).sort()).toEqual(
        ["defproducera", "defproducera", "defproducerb", "defproducerb"].sort()
      )
      expect(
        Steps.keys
          .signatureProviderKeyPublications(topology)
          .filter(publication => publication.secretId.includes("defproducer"))
      ).toEqual([])
    })

    it("in a MIXED topology publishes shared-node producers under their own labels and a sole producer under its node", () => {
      const topology = ssmTopologyConfig(2, 3),
        idsOf = (label: string) =>
          Steps.keys
            .signatureProviderKeyPublications(topology)
            .filter(publication => publication.label === label)
            .map(publication => publication.secretId)
            .sort()
      expect(idsOf("defproducera")).toEqual([
        "/wire/test/defproducera/BLS",
        "/wire/test/defproducera/K1"
      ])
      expect(idsOf("defproducerc")).toEqual([
        "/wire/test/defproducerc/BLS",
        "/wire/test/defproducerc/K1"
      ])
      expect(idsOf("defproducerb")).toEqual([
        "/wire/test/node_01/BLS",
        "/wire/test/node_01/K1"
      ])
    })

    it.each(ProducerTopologies)(
      "never plans two publications on one secret id (%s)",
      (_name, producerNodeCount, producerCount) => {
        const secretIds = Steps.keys
          .signatureProviderKeyPublications(
            ssmTopologyConfig(producerNodeCount, producerCount)
          )
          .map(publication => publication.secretId)
        expect(new Set(secretIds).size).toBe(secretIds.length)
      }
    )

    it("REFUSES a secret-id pattern under which two identities collide", () => {
      // Without `{account}` every identity's K1 renders the same id; publishing them all would
      // write different keys to one parameter.
      expect(() =>
        Steps.keys.signatureProviderKeyPublications(
          ssmConfig({
            signatureProvider: {
              type: SignatureProviderType.SSM,
              ssm: {
                awsRegions: SSMRegions,
                awsSecretIdPattern: "/wire/{cluster}/{keyType}"
              },
              kms: null,
              batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
            }
          })
        )
      ).toThrow(/publications collide on \/wire\/test\/K1/)
    })

    it("PUBLISHES the bios keys — under SSM the bios node renders SSM: specs and cannot start without them", () => {
      // The regression this pins: the walker enumerated producer nodes only,
      // while the bios daemon renders `SSM:/…/node_bios/{K1,BLS}` from
      // `node.name`. Nothing wrote those parameters, so the bios node could
      // never start on ANY SSM cluster — first run or thousandth.
      const biosKeys = publications.filter(
        publication => publication.label === NodeConfig.BiosName
      )
      expect(biosKeys.map(publication => publication.keyType).sort()).toEqual(
        [KeyType.K1, KeyType.BLS].sort()
      )
      expect(biosKeys.map(publication => publication.secretId)).toEqual(
        expect.arrayContaining([
          `/wire/test/${NodeConfig.BiosName}/K1`,
          `/wire/test/${NodeConfig.BiosName}/BLS`
        ])
      )
    })

    /** The spec scheme prefix a rendered SSM `--signature-provider` carries before its id. */
    const SSMSpecPrefix = "SSM:"

    /** The secret ids of every `--signature-provider` spec in a rendered nodeop argv. */
    function renderedSecretIds(args: string[]): string[] {
      return args
        .filter((_arg, index) => args[index - 1] === NodeopProcess.SignatureProviderFlag)
        .map(spec => spec.slice(spec.indexOf(SSMSpecPrefix) + SSMSpecPrefix.length))
    }

    it.each(ProducerTopologies)(
      "every secret id a producing node RENDERS for its materialized accounts was published (%s)",
      async (_name, producerNodeCount, producerCount) => {
        // Whatever a node's `--signature-provider` resolves to MUST have been published. The
        // expected ids come from what `NodeopProcess.buildArgs` RENDERS for the accounts the
        // real materialization step recorded — never from the publication-label derivation
        // itself, which would make the check circular.
        installSSMStoreMock()
        const ctx = fixtureContext({
            ...fixtureProducerTopologyOverrides(producerNodeCount, producerCount),
            ...ssmOverrides(),
            ...fakeExecutables()
          }),
          producerNodes = producerNodesOf(ctx.config),
          publishedIds = new Set(
            Steps.keys
              .signatureProviderKeyPublications(ctx.config)
              .map(publication => publication.secretId)
          )
        jest
          .spyOn(ctx.wire.wallet, "getOrCreate")
          .mockResolvedValue({ addPrivateKey: jest.fn().mockResolvedValue(undefined) } as never)
        ctx.keyStore.pushNodes(
          ...producerNodes.map(node => ({
            index: node.index,
            keys: {
              wire: {
                type: KeyType.K1 as const,
                publicKey: Constants.DEV_K1_PUBLIC_KEY,
                privateKey: Constants.DEV_K1_PRIVATE_KEY
              },
              wireFinalizer: {
                type: KeyType.BLS as const,
                publicKey: Constants.DEV_BLS_PUBLIC_KEY,
                privateKey: Constants.DEV_BLS_PRIVATE_KEY,
                proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
              }
            }
          }))
        )
        for (const node of producerNodes) {
          for (const label of node.producers) {
            await WireOperatorProvisioningTool.runProducerMaterialization(
              ctx,
              {
                kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
                label,
                producerNodeIndex: node.index,
                publicationLabel: NodeConfig.producerPublicationLabel(node, label)
              },
              new AbortController().signal
            )
          }
        }
        // Only a PRODUCING node renders `--signature-provider` specs; the bios node is one.
        const producingNodes = NodeConfig.plan(ctx.config).filter(
          node => node.producers.length > 0
        )
        expect(producingNodes.length).toBe(producerNodeCount + 1)
        producingNodes.forEach(node => {
          const operators = Steps.processes.nodeop.resolveOperators(ctx, node),
            rendered = renderedSecretIds(
              NodeopProcess.buildArgs(
                NodeopProcess.resolveConfig(
                  { node, operators },
                  { genesisTimestamp: GenesisTimestamp, supportsTraceNoAbis: true }
                )
              )
            )
          // One block-signing K1 spec plus one finalizer BLS spec per hosted account.
          expect(rendered).toHaveLength(1 + node.producers.length)
          rendered.forEach(secretId => expect(publishedIds).toContain(secretId))
          // A node hosting one producer (the bios node included) renders ONLY node-named ids;
          // a shared node renders none.
          expect(
            rendered.filter(secretId => secretId.includes(`/${node.name}/`))
          ).toHaveLength(node.producers.length === 1 ? rendered.length : 0)
        })
      }
    )

    it("keys each secret id by the AWS ACCOUNT, not the cluster-path basename", () => {
      const batchK1 = publications.find(
        publication =>
          publication.label === "batchop.a" &&
          publication.keyType === KeyType.K1
      )
      // `{cluster}` = awsClusterNodeConfig.account (`test`) — the cluster dir is
      // `/tmp/wire-cluster-pubs` and must NOT appear.
      expect(batchK1?.secretId).toBe("/wire/test/batchop.a/K1")
      expect(batchK1?.awsRegions).toEqual(SSMRegions)
      expect(batchK1).not.toHaveProperty("privateKey")
    })

    it("carries no version when the cluster's SSM settings declare none", () => {
      expect(
        publications.every(publication => publication.version == null)
      ).toBe(true)
    })

    it("renders the OPTIONAL {version} token when the pattern authors it, and carries it as the tag value", () => {
      const versioned = Steps.keys.signatureProviderKeyPublications(
        ssmConfig({
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: SSMRegions,
              awsSecretIdPattern:
                "/wire/{cluster}/{account}/{keyType}/{version}",
              version: "v4"
            },
            kms: null,
            batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
          }
        })
      )
      const batchK1 = versioned.find(
        publication =>
          publication.label === "batchop.a" &&
          publication.keyType === KeyType.K1
      )
      expect(batchK1?.secretId).toBe("/wire/test/batchop.a/K1/v4")
      expect(batchK1?.version).toBe("v4")
    })

    it("throws on a KEY provider (SSM settings required)", () => {
      expect(() =>
        Steps.keys.signatureProviderKeyPublications(fixtureConfig())
      ).toThrow(/SSM signature provider requires ssm settings/)
    })

    it("throws when an SSM cluster carries no awsClusterNodeConfig", () => {
      expect(() =>
        Steps.keys.signatureProviderKeyPublications(
          ssmConfig({ awsClusterNodeConfig: null })
        )
      ).toThrow(/requires awsClusterNodeConfig/)
    })
  })

  describe("planSignatureProviderKeyPublications", () => {
    const config = ssmConfig()

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

    it("composes the beforeNodes phase: every key a nodeop fetches at startup, self-registered", () => {
      const { parent, children } = fixtureParent()
      const phase = Steps.keys.planSignatureProviderKeyPublications(
        parent as never,
        "PublishNodeSignatureProviderKeys",
        "publish node keys",
        {},
        config,
        Steps.keys.SignatureKeyPublishPhase.beforeNodes
      )
      expect(children).toContain(phase)
      expect(phase.name).toBe("PublishNodeSignatureProviderKeys")
      // Genesis (bios K1+BLS) + every producer ACCOUNT (K1+BLS each).
      // The bios entries MUST be here and not in the operator phase: that phase
      // composes after BiosNode has already started, so publishing them there
      // would leave the bios daemon fetching parameters that do not yet exist.
      // The producer ACCOUNTS are here for the same reason: a producing node renders one
      // `--signature-provider ...SSM:` per hosted account at LAUNCH.
      const producerAccounts = NodeConfig.plan(config)
        .filter(node => node.role === NodeRole.producer)
        .flatMap(node => node.producers)
      expect(phase.steps.map(step => step.name)).toEqual([
        "publish-node_bios-K1",
        "publish-node_bios-BLS",
        // No `publish-node_00-*`: a producer node publishes nothing under its own name.
        ...producerAccounts.flatMap(label => [
          `publish-${label}-K1`,
          `publish-${label}-BLS`
        ])
      ])
    })

    it("names a node's SOLE producer's publish steps for the NODE they publish under", () => {
      const { parent } = fixtureParent(),
        phase = Steps.keys.planSignatureProviderKeyPublications(
          parent as never,
          "PublishNodeSignatureProviderKeys",
          "publish node keys",
          {},
          ssmTopologyConfig(1, 1),
          Steps.keys.SignatureKeyPublishPhase.beforeNodes
        ),
        producerSteps = phase.steps.filter(step => step.name.startsWith("publish-node_00-"))
      expect(producerSteps.map(step => step.name)).toEqual([
        "publish-node_00-K1",
        "publish-node_00-BLS"
      ])
      // The description still names whose key it is.
      expect(producerSteps.map(step => step.description)).toEqual([
        "publish defproducera key node_00 K1 → SSM",
        "publish defproducera key node_00 BLS → SSM"
      ])
      expect(phase.steps.some(step => step.name.includes("defproducer"))).toBe(false)
    })

    it("composes the operator-source phase: one step per operator key", () => {
      const { parent } = fixtureParent()
      const phase = Steps.keys.planSignatureProviderKeyPublications(
        parent as never,
        "PublishOperatorSignatureProviderKeys",
        "publish operator keys",
        {},
        config,
        Steps.keys.SignatureKeyPublishPhase.afterOperators
      )
      // 3 batch operators × (K1 + EM + ED) = 9. Producer ACCOUNTS are operator-source
      // too, but publish in the beforeNodes phase (their nodes fetch those keys at launch), so
      // they are deliberately NOT here.
      expect(phase.steps).toHaveLength(9)
      expect(
        phase.steps.every(step => !step.name.startsWith("publish-defproducer"))
      ).toBe(true)
      expect(
        phase.steps.every(step => !step.name.startsWith("publish-node_"))
      ).toBe(true)
    })

    it("builds publish inputs from CONFIG ALONE — no 'adopted' flag at compose time", () => {
      const { parent } = fixtureParent()
      const phase = Steps.keys.planSignatureProviderKeyPublications(
        parent as never,
        "PublishOperatorSignatureProviderKeys",
        "publish operator keys",
        {},
        config,
        Steps.keys.SignatureKeyPublishPhase.afterOperators
      )
      // Whether a region already holds a parameter is a RUNTIME fact the runner
      // discovers per region — an input flag would be decided before any key
      // exists, and would be wrong for every region that disagreed.
      phase.steps.forEach(step => {
        expect(step.input).not.toHaveProperty("adopted")
        expect(step.input).not.toHaveProperty("privateKey")
      })
    })
  })

  describe("signatureProviderSecretId", () => {
    it("renders the id an SSM cluster publishes a key under", () => {
      expect(
        Steps.keys.signatureProviderSecretId(
          ssmConfig(),
          "batchop.a",
          KeyType.EM
        )
      ).toBe("/wire/test/batchop.a/EM")
    })

    it("is absent under KEY — there is nothing to adopt", () => {
      expect(
        Steps.keys.signatureProviderSecretId(
          fixtureConfig(),
          "batchop.a",
          KeyType.EM
        )
      ).toBeNull()
    })
  })

  describe("adoptOrCreateSignatureProviderKey (D21, at the GENERATION seam)", () => {
    it("ADOPTS an existing parameter instead of regenerating it", async () => {
      installSSMStoreMock()
      const existing = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY)
      publishEverywhere("/wire/test/batchop.a/K1", existing.toNativeString())
      const adopted = await Steps.keys.adoptOrCreateSignatureProviderKey(
        ssmConfig(fakeExecutables()),
        KeyType.K1,
        "batchop.a",
        keyContext()
      )
      expect(adopted.privateKey).toBe(existing.toString())
      expect(adopted.publicKey).toBe(existing.toPublic().toString())
      // Probed only; nothing was written.
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("GENERATES when no region holds the parameter", async () => {
      installSSMStoreMock()
      const created = await Steps.keys.adoptOrCreateSignatureProviderKey(
        ssmConfig(fakeExecutables()),
        KeyType.K1,
        "batchop.a",
        keyContext()
      )
      // A RANDOM key — never the dev key — whose public half is its own derivation.
      expect(created.privateKey).toMatch(/^PVT_K1_/)
      expect(created.privateKey).not.toBe(
        PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toString()
      )
      expect(PrivateKey.from(created.privateKey).toPublic().toString()).toBe(
        created.publicKey
      )
      // Every region was probed before falling back to generation.
      expect(commandInputs("GetParameter").map(input => input.Name)).toEqual(
        SSMRegions.map(() => "/wire/test/batchop.a/K1")
      )
    })

    it("adopts a BLS key WITH its proof of possession", async () => {
      installSSMStoreMock()
      publishEverywhere(
        "/wire/test/node_00/BLS",
        PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString()
      )
      const adopted = await Steps.keys.adoptOrCreateSignatureProviderKey(
        ssmConfig(fakeExecutables()),
        KeyType.BLS,
        "node_00",
        keyContext()
      )
      expect(adopted.proofOfPossession).toBe(
        Constants.DEV_BLS_PROOF_OF_POSSESSION
      )
    })

    it("HARD-FAILS when two regions hold different values for the same id", async () => {
      mockSend
        .mockResolvedValueOnce(
          secureStringResponse(
            PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()
          )
        )
        .mockResolvedValueOnce(
          secureStringResponse(PrivateKey.generate(KeyType.K1).toNativeString())
        )
      await expect(
        Steps.keys.adoptOrCreateSignatureProviderKey(
          ssmConfig(fakeExecutables()),
          KeyType.K1,
          "batchop.a",
          keyContext()
        )
      ).rejects.toThrow(/DIVERGES across regions/)
    })

    it("never touches SSM under a KEY provider", async () => {
      installSSMStoreMock()
      const created = await Steps.keys.adoptOrCreateSignatureProviderKey(
        fixtureConfig(fakeExecutables()),
        KeyType.K1,
        "batchop.a",
        keyContext()
      )
      expect(created.type).toBe(KeyType.K1)
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe("KMS custody of the K1 / EM / ED keys (an SSM cluster with kms settings)", () => {
    /** The ONE region the KMS keys live in — one of the replication regions. */
    const KmsRegion = "us-east-1"
    /** The alias the KMS pattern renders for the first batch operator's EM key (`batchop.a` → `batchop-a`). */
    const BatchOperatorAlias = "alias/wire/test/batchop-a/EM"
    /** The alias the KMS pattern renders for the first batch operator's ED key. */
    const BatchOperatorSolanaAlias = "alias/wire/test/batchop-a/ED"
    /** The kms settings custodying the EM curve ONLY (ED stays in SSM). */
    const EthereumOnlyKms: Partial<AWSKMSSignatureProviderOptions> = {
      keyTypes: [KeyType.EM]
    }

    /** Per-test shape of the kms settings + the batch-operator key policy. */
    interface KmsConfigOptions {
      kms?: Partial<AWSKMSSignatureProviderOptions>
      policy?: SignatureProviderKeyPolicy
    }

    /** The SSM fixture plus kms settings — both OUTPOST curves unless `kms.keyTypes` says otherwise (and, when given, an explicit key policy). */
    function ssmKmsConfig(
      overrides: Partial<ClusterConfig> = {},
      { kms = {}, policy = SignatureProviderKeyPolicy.adoptOrCreate }: KmsConfigOptions = {}
    ): ClusterConfig {
      const base = ssmOverrides()
      return fixtureConfig({
        ...base,
        signatureProvider: {
          ...base.signatureProvider,
          kms: {
            awsKeyAliasPattern: "alias/wire/{cluster}/{account}/{keyType}",
            awsRegion: KmsRegion,
            keyTypes: [KeyType.EM, KeyType.ED],
            ...kms
          },
          batchOperatorKeyPolicy: policy
        },
        ...overrides
      })
    }

    /** Adopt-or-create `keyType` for `account` under `config`, inside a recorder scope. */
    async function adoptOrCreate<T extends KeyType>(
      config: ClusterConfig,
      keyType: T,
      account: string,
      recorder = new StepExtraRecorder(),
      purpose?: string
    ) {
      return StepExtraRecorder.runWith(recorder, () =>
        Steps.keys.adoptOrCreateSignatureProviderKey(
          config,
          keyType,
          account,
          keyContext(),
          purpose == null ? {} : { purpose }
        )
      )
    }

    it("custodySource renders the KMS source for the EM key — the one region + the alias, dots mapped to dashes", () => {
      expect(
        ClusterConfigProvider.custodySource(
          ssmKmsConfig(),
          "batchop.a",
          KeyType.EM
        )
      ).toEqual({
        type: SignatureProviderType.KMS,
        awsKmsRegion: KmsRegion,
        awsKmsKeyId: BatchOperatorAlias
      })
    })

    it("ADOPTS the KMS key behind the rendered alias — a material-less pair carrying the key reference, with a note", async () => {
      installSSMStoreMock()
      installKMSStoreMock()
      const { wallet, arn } = seedKmsKey(BatchOperatorAlias),
        recorder = new StepExtraRecorder(),
        adopted = await adoptOrCreate(
          ssmKmsConfig(fakeExecutables()),
          KeyType.EM,
          "batchop.a",
          recorder
        )
      expect(adopted).toEqual({
        type: KeyType.EM,
        publicKey: ethereumPublicKeyFromWallet(wallet).toString(),
        address: wallet.address,
        awsKmsRegion: KmsRegion,
        awsKmsKeyId: BatchOperatorAlias
      })
      expect(adopted).not.toHaveProperty("privateKey")
      // Probed only — no key minted, no alias bound, and SSM never consulted for the EM curve.
      expect(kmsCommandInputs("GetPublicKey")).toEqual([{ KeyId: BatchOperatorAlias }])
      expect(kmsCommandInputs("CreateKey")).toEqual([])
      expect(mockSend).not.toHaveBeenCalled()
      expect(recorder.calls).toEqual([
        {
          client: "harness",
          kind: "note",
          text: "adopted batchop.a's existing EM key from KMS",
          account: "batchop.a",
          keyType: "EM",
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorAlias,
          keyArn: arn
        }
      ])
    })

    it("CREATES the key INSIDE KMS when nothing is behind the alias (adoptOrCreate) — tagged with the platform version, recorded as an aws-kms keygen", async () => {
      installSSMStoreMock()
      installKMSStoreMock()
      const recorder = new StepExtraRecorder(),
        purpose = "batch operator batchop.a — ethereum outpost key (EM)",
        created = await adoptOrCreate(
          ssmKmsConfig(fakeExecutables(), { kms: { version: "v4" } }),
          KeyType.EM,
          "batchop.a",
          recorder,
          purpose
        ),
        key = kmsStore.get(BatchOperatorAlias)
      expect(key).toBeDefined()
      // Probe (not found) → CreateKey → CreateAlias(ARN) → read back through the alias.
      expect(kmsCommandInputs("GetPublicKey")).toEqual([
        { KeyId: BatchOperatorAlias },
        { KeyId: BatchOperatorAlias }
      ])
      expect(kmsCommandInputs("CreateKey")).toEqual([
        {
          KeySpec: KeySpec.ECC_SECG_P256K1,
          KeyUsage: KeyUsageType.SIGN_VERIFY,
          Description: purpose,
          Tags: [{ TagKey: Steps.keys.PlatformVersionTagKey, TagValue: "v4" }]
        }
      ])
      expect(kmsCommandInputs("CreateAlias")).toEqual([
        { AliasName: BatchOperatorAlias, TargetKeyId: key.arn }
      ])
      expect(created).toEqual({
        type: KeyType.EM,
        publicKey: ethereumPublicKeyFromWallet(key.wallet).toString(),
        address: key.wallet.address,
        awsKmsRegion: KmsRegion,
        awsKmsKeyId: BatchOperatorAlias
      })
      expect(created).not.toHaveProperty("privateKey")
      // The keygen is recorded like a local one — public half, purpose, mechanism; no material (KMS has none to give).
      expect(recorder.calls).toEqual([
        {
          client: "aws-kms",
          kind: "keygen",
          keyType: "EM",
          purpose,
          keyArn: key.arn,
          ...created
        }
      ])
      // Nothing was put to SSM for a KMS-custodied curve.
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("omits Tags entirely when the kms settings declare no version, and describes the key by account + curve without a purpose", async () => {
      installSSMStoreMock()
      installKMSStoreMock()
      await adoptOrCreate(ssmKmsConfig(fakeExecutables()), KeyType.EM, "batchop.b")
      const [createKey] = kmsCommandInputs("CreateKey")
      expect(createKey).not.toHaveProperty("Tags")
      expect(createKey.Description).toBe("batchop.b EM signing key")
    })

    it("keeps every other curve in SSM — the K1 of the same operator adopts from / generates into Parameter Store", async () => {
      installSSMStoreMock()
      installKMSStoreMock()
      const existing = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY)
      publishEverywhere("/wire/test/batchop.a/K1", existing.toNativeString())
      const adopted = await adoptOrCreate(
        ssmKmsConfig(fakeExecutables()),
        KeyType.K1,
        "batchop.a"
      )
      expect(adopted.privateKey).toBe(existing.toString())
      expect(mockKmsSend).not.toHaveBeenCalled()
    })

    describe("the ED (solana) key — an ECC_NIST_EDWARDS25519 KMS key", () => {
      it("custodySource renders the KMS source for the ED key under the default keyTypes, and the SSM source under [EM]", () => {
        expect(
          ClusterConfigProvider.custodySource(ssmKmsConfig(), "batchop.a", KeyType.ED)
        ).toEqual({
          type: SignatureProviderType.KMS,
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorSolanaAlias
        })
        expect(
          ClusterConfigProvider.custodySource(
            ssmKmsConfig({}, { kms: EthereumOnlyKms }),
            "batchop.a",
            KeyType.ED
          )
        ).toEqual({
          type: SignatureProviderType.SSM,
          awsSecretId: "/wire/test/batchop.a/ED"
        })
      })

      it("ADOPTS the Ed25519 key behind the rendered alias — a material-less PUB_ED_ pair carrying the key reference", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const { keypair, arn } = seedKmsSolanaKey(BatchOperatorSolanaAlias),
          recorder = new StepExtraRecorder(),
          adopted = await adoptOrCreate(
            ssmKmsConfig(fakeExecutables()),
            KeyType.ED,
            "batchop.a",
            recorder
          )
        expect(adopted).toEqual({
          type: KeyType.ED,
          publicKey: PublicKey.from({
            type: KeyType.ED,
            compressed: keypair.publicKey.toBytes()
          }).toString(),
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorSolanaAlias
        })
        expect(adopted).not.toHaveProperty("privateKey")
        // The pair's base58 IS the keypair's Solana key — the daemon spec and the outposts name it.
        expect(PublicKey.from(adopted.publicKey).toNativeString()).toBe(
          keypair.publicKey.toBase58()
        )
        expect(kmsCommandInputs("GetPublicKey")).toEqual([
          { KeyId: BatchOperatorSolanaAlias }
        ])
        expect(kmsCommandInputs("CreateKey")).toEqual([])
        expect(mockSend).not.toHaveBeenCalled()
        expect(recorder.calls).toEqual([
          expect.objectContaining({
            kind: "note",
            text: "adopted batchop.a's existing ED key from KMS",
            keyType: "ED",
            awsKmsKeyId: BatchOperatorSolanaAlias,
            keyArn: arn
          })
        ])
      })

      it("CREATES the key INSIDE KMS with the Ed25519 spec when nothing is behind the alias, recorded as an aws-kms keygen", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const recorder = new StepExtraRecorder(),
          created = await adoptOrCreate(
            ssmKmsConfig(fakeExecutables(), { kms: { version: "v4" } }),
            KeyType.ED,
            "batchop.a",
            recorder
          ),
          key = kmsStore.get(BatchOperatorSolanaAlias)
        expect(key?.keyType).toBe(KeyType.ED)
        expect(kmsCommandInputs("CreateKey")).toEqual([
          {
            KeySpec: KeySpec.ECC_NIST_EDWARDS25519,
            KeyUsage: KeyUsageType.SIGN_VERIFY,
            Description: "batchop.a ED signing key",
            Tags: [{ TagKey: Steps.keys.PlatformVersionTagKey, TagValue: "v4" }]
          }
        ])
        expect(kmsCommandInputs("CreateAlias")).toEqual([
          { AliasName: BatchOperatorSolanaAlias, TargetKeyId: key.arn }
        ])
        expect(created).toEqual({
          type: KeyType.ED,
          publicKey: PublicKey.from({
            type: KeyType.ED,
            compressed: key.keypair.publicKey.toBytes()
          }).toString(),
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorSolanaAlias
        })
        expect(recorder.calls).toEqual([
          {
            client: "aws-kms",
            kind: "keygen",
            keyType: "ED",
            purpose: null,
            keyArn: key.arn,
            ...created
          }
        ])
        expect(commandInputs("PutParameter")).toEqual([])
      })

      it("keyTypes [EM]: the ED key adopts from / generates into Parameter Store and KMS is never consulted for it", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const existing = PrivateKey.generate(KeyType.ED)
        publishEverywhere("/wire/test/batchop.a/ED", existing.toNativeString())
        const adopted = await adoptOrCreate(
          ssmKmsConfig(fakeExecutables(), { kms: EthereumOnlyKms }),
          KeyType.ED,
          "batchop.a"
        )
        expect(adopted.privateKey).toBe(existing.toString())
        expect(adopted).not.toHaveProperty("awsKmsKeyId")
        expect(mockKmsSend).not.toHaveBeenCalled()
      })

      it("adoptOnly: a bootstrap batch operator's MISSING ED key FAILS naming the KMS custody id, nothing minted", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        await expect(
          adoptOrCreate(
            ssmKmsConfig(fakeExecutables(), {
              policy: SignatureProviderKeyPolicy.adoptOnly
            }),
            KeyType.ED,
            "batchop.a"
          )
        ).rejects.toThrow(
          /no existing ED key was found for batch operator batchop\.a at us-east-1:alias\/wire\/test\/batchop-a\/ED/
        )
        expect(kmsCommandInputs("CreateKey")).toEqual([])
      })
    })

    describe("the K1 (wire) key — a BOOTSTRAP batch operator's ACCOUNT key, an ECC_SECG_P256K1 KMS key like EM", () => {
      /** The alias the KMS pattern renders for the first batch operator's K1 key. */
      const BatchOperatorWireAlias = "alias/wire/test/batchop-a/K1"
      /** The kms settings custodying EVERY curve — K1 included (the roster's default). */
      const AllCurvesKms: Partial<AWSKMSSignatureProviderOptions> = {
        keyTypes: [KeyType.K1, KeyType.EM, KeyType.ED]
      }
      /** The `PUB_K1_…` a held secp256k1 point reports as. */
      function wirePublicKeyOf(wallet: ethers.HDNodeWallet): string {
        return PublicKey.from({
          type: KeyType.K1,
          compressed: ethers.getBytes(
            ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
          )
        }).toString()
      }

      it("custodySource renders the KMS source for a bootstrap batch operator's K1 under [K1, EM, ED], and the SSM source under the fixture's [EM, ED]", () => {
        expect(
          ClusterConfigProvider.custodySource(
            ssmKmsConfig({}, { kms: AllCurvesKms }),
            "batchop.a",
            KeyType.K1
          )
        ).toEqual({
          type: SignatureProviderType.KMS,
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorWireAlias
        })
        expect(
          ClusterConfigProvider.custodySource(ssmKmsConfig(), "batchop.a", KeyType.K1)
        ).toEqual({
          type: SignatureProviderType.SSM,
          awsSecretId: "/wire/test/batchop.a/K1"
        })
      })

      it("keeps every OTHER identity's K1 in SSM even under [K1, EM, ED] — a producer node, the genesis identity, a flow operator (nodeop requires a block-signing K1 local)", () => {
        const config = ssmKmsConfig({}, { kms: AllCurvesKms })
        ;["node_00", NodeConfig.BiosName, "depositoraaa"].forEach(account =>
          expect(
            ClusterConfigProvider.custodySource(config, account, KeyType.K1)
          ).toEqual({
            type: SignatureProviderType.SSM,
            awsSecretId: `/wire/test/${account}/K1`
          })
        )
        // …while the same identities' EM keys DO go to KMS — the account gate is on K1 only.
        expect(
          ClusterConfigProvider.custodySource(config, "depositoraaa", KeyType.EM).type
        ).toBe(SignatureProviderType.KMS)
      })

      it("ADOPTS the secp256k1 key behind the rendered alias — a material-less PUB_K1_ pair carrying the key reference, SSM never consulted", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const { wallet, arn } = seedKmsWireKey(BatchOperatorWireAlias),
          recorder = new StepExtraRecorder(),
          adopted = await adoptOrCreate(
            ssmKmsConfig(fakeExecutables(), { kms: AllCurvesKms }),
            KeyType.K1,
            "batchop.a",
            recorder
          )
        expect(adopted).toEqual({
          type: KeyType.K1,
          publicKey: wirePublicKeyOf(wallet),
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorWireAlias
        })
        expect(adopted).not.toHaveProperty("privateKey")
        expect(kmsCommandInputs("GetPublicKey")).toEqual([{ KeyId: BatchOperatorWireAlias }])
        expect(kmsCommandInputs("CreateKey")).toEqual([])
        expect(mockSend).not.toHaveBeenCalled()
        expect(recorder.calls).toEqual([
          expect.objectContaining({
            kind: "note",
            text: "adopted batchop.a's existing K1 key from KMS",
            keyType: "K1",
            awsKmsKeyId: BatchOperatorWireAlias,
            keyArn: arn
          })
        ])
      })

      it("CREATES the key INSIDE KMS with the secp256k1 spec when nothing is behind the alias, recorded as an aws-kms keygen, nothing put to SSM", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const recorder = new StepExtraRecorder(),
          purpose = "batch operator batchop.a — WIRE account key (K1)",
          created = await adoptOrCreate(
            ssmKmsConfig(fakeExecutables(), { kms: { ...AllCurvesKms, version: "v4" } }),
            KeyType.K1,
            "batchop.a",
            recorder,
            purpose
          ),
          key = kmsStore.get(BatchOperatorWireAlias)
        expect(key).toBeDefined()
        expect(kmsCommandInputs("CreateKey")).toEqual([
          {
            KeySpec: KeySpec.ECC_SECG_P256K1,
            KeyUsage: KeyUsageType.SIGN_VERIFY,
            Description: purpose,
            Tags: [{ TagKey: Steps.keys.PlatformVersionTagKey, TagValue: "v4" }]
          }
        ])
        expect(kmsCommandInputs("CreateAlias")).toEqual([
          { AliasName: BatchOperatorWireAlias, TargetKeyId: key.arn }
        ])
        expect(created).toEqual({
          type: KeyType.K1,
          publicKey: wirePublicKeyOf(key.wallet),
          awsKmsRegion: KmsRegion,
          awsKmsKeyId: BatchOperatorWireAlias
        })
        expect(created).not.toHaveProperty("privateKey")
        expect(recorder.calls).toEqual([
          {
            client: "aws-kms",
            kind: "keygen",
            keyType: "K1",
            purpose,
            keyArn: key.arn,
            ...created
          }
        ])
        expect(commandInputs("PutParameter")).toEqual([])
      })

      it("a producer node's K1 adopts from / generates into Parameter Store under [K1, EM, ED] — KMS is never consulted for a block-signing key", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const existing = PrivateKey.generate(KeyType.K1)
        publishEverywhere("/wire/test/node_00/K1", existing.toNativeString())
        const adopted = await adoptOrCreate(
          ssmKmsConfig(fakeExecutables(), { kms: AllCurvesKms }),
          KeyType.K1,
          "node_00"
        )
        expect(adopted.privateKey).toBe(existing.toString())
        expect(adopted).not.toHaveProperty("awsKmsKeyId")
        const generated = await adoptOrCreate(
          ssmKmsConfig(fakeExecutables(), { kms: AllCurvesKms }),
          KeyType.K1,
          "node_01"
        )
        expect(generated.privateKey).toMatch(/^PVT_K1_/)
        expect(generated).not.toHaveProperty("awsKmsKeyId")
        expect(mockKmsSend).not.toHaveBeenCalled()
      })

      it("adoptOnly: a bootstrap batch operator's MISSING K1 FAILS naming the KMS custody id, nothing minted", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        await expect(
          adoptOrCreate(
            ssmKmsConfig(fakeExecutables(), {
              kms: AllCurvesKms,
              policy: SignatureProviderKeyPolicy.adoptOnly
            }),
            KeyType.K1,
            "batchop.a"
          )
        ).rejects.toThrow(
          /no existing K1 key was found for batch operator batchop\.a at us-east-1:alias\/wire\/test\/batchop-a\/K1/
        )
        expect(kmsCommandInputs("CreateKey")).toEqual([])
      })

      it("the publication walkers EXCLUDE a bootstrap batch operator's K1 (no parameter to put) and KEEP a producer's / the genesis identity's", () => {
        const allCurves = ssmKmsConfig({}, { kms: AllCurvesKms }),
          without = Steps.keys.signatureProviderKeyPublications(ssmConfig()),
          outpostCurves = [KeyType.EM, KeyType.ED]
        expect(
          Steps.keys.operatorKeyPublications(allCurves, "batchop.a", OperatorType.BATCH)
        ).toEqual([])
        const withAll = Steps.keys.signatureProviderKeyPublications(allCurves)
        expect(
          withAll.some(publication => Constants.isBatchOperatorLabel(publication.label))
        ).toBe(false)
        expect(withAll).toEqual(
          without.filter(
            publication =>
              !Constants.isBatchOperatorLabel(publication.label) &&
              !outpostCurves.includes(publication.keyType)
          )
        )
        // The genesis identity's K1 row survives — nodeop requires that key local.
        expect(
          withAll.some(
            publication =>
              publication.publicationLabel === NodeConfig.BiosName &&
              publication.keyType === KeyType.K1
          )
        ).toBe(true)
        expect(
          Steps.keys.signatureProviderSecretId(allCurves, "batchop.a", KeyType.K1)
        ).toBeNull()
        expect(
          Steps.keys.signatureProviderSecretId(allCurves, "node_00", KeyType.K1)
        ).toBe("/wire/test/node_00/K1")
      })

      it("custodyReference agrees with the ONE renderer — KMS:<region>:<alias> for the batch operator's K1, SSM:<secretId> for a node's", () => {
        const allCurves = ssmKmsConfig({}, { kms: AllCurvesKms })
        expect(
          Steps.keys.custodyReference(
            ClusterConfigProvider.custodySource(allCurves, "batchop.a", KeyType.K1)
          )
        ).toBe(`KMS:${KmsRegion}:${BatchOperatorWireAlias}`)
        expect(
          Steps.keys.custodyReference(
            ClusterConfigProvider.custodySource(allCurves, "node_00", KeyType.K1)
          )
        ).toBe("SSM:/wire/test/node_00/K1")
      })
    })

    describe("the batchOperatorKeyPolicy gate on the CREATE arm", () => {
      it("adoptOnly: a bootstrap batch operator's MISSING key FAILS naming the custody id and the pre-create command — KMS and SSM alike, nothing minted", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const config = ssmKmsConfig(fakeExecutables(), {
          policy: SignatureProviderKeyPolicy.adoptOnly
        })
        await expect(adoptOrCreate(config, KeyType.EM, "batchop.a")).rejects.toThrow(
          /batchOperatorKeyPolicy is adoptOnly and no existing EM key was found for batch operator batchop\.a at us-east-1:alias\/wire\/test\/batchop-a\/EM — pre-create its keys \(wire-cluster-tool create-batch-operator-keys\) before bootstrapping/
        )
        await expect(adoptOrCreate(config, KeyType.K1, "batchop.b")).rejects.toThrow(
          /no existing K1 key was found for batch operator batchop\.b at \/wire\/test\/batchop\.b\/K1/
        )
        expect(kmsCommandInputs("CreateKey")).toEqual([])
        expect(commandInputs("PutParameter")).toEqual([])
      })

      it("adoptOnly: an EXISTING batch-operator key is adopted exactly as under adoptOrCreate", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const { wallet } = seedKmsKey(BatchOperatorAlias),
          k1 = PrivateKey.generate(KeyType.K1)
        publishEverywhere("/wire/test/batchop.a/K1", k1.toNativeString())
        const config = ssmKmsConfig(fakeExecutables(), {
          policy: SignatureProviderKeyPolicy.adoptOnly
        })
        expect((await adoptOrCreate(config, KeyType.EM, "batchop.a")).address).toBe(
          wallet.address
        )
        expect((await adoptOrCreate(config, KeyType.K1, "batchop.a")).privateKey).toBe(
          k1.toString()
        )
      })

      it("adoptOnly: every OTHER identity still creates — a producer node, the genesis identity, a flow operator", async () => {
        installSSMStoreMock()
        installKMSStoreMock()
        const config = ssmKmsConfig(fakeExecutables(), {
          policy: SignatureProviderKeyPolicy.adoptOnly
        })
        expect((await adoptOrCreate(config, KeyType.K1, "node_00")).privateKey).toMatch(
          /^PVT_K1_/
        )
        expect(
          (await adoptOrCreate(config, KeyType.K1, NodeConfig.BiosName)).privateKey
        ).toMatch(/^PVT_K1_/)
        const flowOperator = await adoptOrCreate(config, KeyType.EM, "depositoraaa")
        expect(flowOperator.awsKmsKeyId).toBe("alias/wire/test/depositoraaa/EM")
        expect(kmsStore.has("alias/wire/test/depositoraaa/EM")).toBe(true)
      })

      it("adoptOnly on a KEY cluster: a batch operator's key cannot be minted here (the held identity is the adoption path) — the message names no custody id", async () => {
        installSSMStoreMock()
        await expect(
          adoptOrCreate(
            fixtureConfig({
              ...fakeExecutables(),
              signatureProvider: {
                type: SignatureProviderType.KEY,
                ssm: null,
                kms: null,
                batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
              }
            }),
            KeyType.K1,
            "batchop.a"
          )
        ).rejects.toThrow(
          /no existing K1 key was found for batch operator batchop\.a — pre-create its keys/
        )
        expect(mockSend).not.toHaveBeenCalled()
      })
    })

    describe("publishSignatureProviderKey (the extracted per-region probe-then-put primitive)", () => {
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY),
        publication: Steps.keys.SignatureProviderKeyPublication = {
          publishPhase: Steps.keys.SignatureKeyPublishPhase.afterOperators,
          label: "batchop.a",
          publicationLabel: "batchop.a",
          keyType: KeyType.K1,
          awsRegions: SSMRegions,
          secretId: "/wire/test/batchop.a/K1",
          version: "v4"
        }

      it("puts the key's NATIVE string to EVERY region, Overwrite false, tagged with the version", async () => {
        installSSMStoreMock()
        await Steps.keys.publishSignatureProviderKey(publication, k1.toString())
        const puts = commandInputs("PutParameter")
        expect(puts).toHaveLength(SSMRegions.length)
        puts.forEach(put =>
          expect(put).toEqual({
            Name: publication.secretId,
            Value: k1.toNativeString(),
            Type: "SecureString",
            Overwrite: false,
            Tags: [{ Key: Steps.keys.PlatformVersionTagKey, Value: "v4" }]
          })
        )
        expect(mockSend.mock.calls.map(([, region]) => region)).toEqual(
          SSMRegions.flatMap(region => [region, region])
        )
      })

      it("RETAINS a region that already holds THIS key and still writes the region that is behind", async () => {
        installSSMStoreMock()
        regionStore(SSMRegions[0]).set(publication.secretId, k1.toNativeString())
        await Steps.keys.publishSignatureProviderKey(publication, k1.toString())
        expect(commandInputs("PutParameter")).toHaveLength(1)
        expect(regionStore(SSMRegions[1]).get(publication.secretId)).toBe(
          k1.toNativeString()
        )
      })

      it("REFUSES a region holding a DIFFERENT key — the stale parameter is never overwritten", async () => {
        installSSMStoreMock()
        regionStore(SSMRegions[0]).set(
          publication.secretId,
          PrivateKey.generate(KeyType.K1).toNativeString()
        )
        await expect(
          Steps.keys.publishSignatureProviderKey(publication, k1.toString())
        ).rejects.toThrow(
          /\/wire\/test\/batchop\.a\/K1 in us-east-1 already holds a DIFFERENT K1 key than the one materialized for batchop\.a — rotate or delete the stale parameter/
        )
        expect(commandInputs("PutParameter")).toEqual([])
      })

      it("REFUSES a region holding a value that is not a key of that curve at all", async () => {
        installSSMStoreMock()
        regionStore(SSMRegions[0]).set(publication.secretId, "not-a-key")
        await expect(
          Steps.keys.publishSignatureProviderKey(publication, k1.toString())
        ).rejects.toThrow(/holds a value that is not a K1 private key/)
      })

      it("omits Tags when the publication carries no version", async () => {
        installSSMStoreMock()
        await Steps.keys.publishSignatureProviderKey(
          { ...publication, version: undefined },
          k1.toString()
        )
        commandInputs("PutParameter").forEach(put =>
          expect(put).not.toHaveProperty("Tags")
        )
      })
    })

    describe("the publication walkers EXCLUDE a KMS-custodied curve (no parameter to put)", () => {
      it("operatorKeyPublications keeps ONLY the K1 row under the default keyTypes, the K1 + ED rows under [EM], and every row without kms", () => {
        const rows = (config: ClusterConfig) =>
          Steps.keys
            .operatorKeyPublications(config, "batchop.a", OperatorType.BATCH)
            .map(publication => [KeyType[publication.keyType], publication.secretId])
        expect(rows(ssmKmsConfig())).toEqual([["K1", "/wire/test/batchop.a/K1"]])
        expect(rows(ssmKmsConfig({}, { kms: EthereumOnlyKms }))).toEqual([
          ["K1", "/wire/test/batchop.a/K1"],
          ["ED", "/wire/test/batchop.a/ED"]
        ])
        expect(
          Steps.keys
            .operatorKeyPublications(ssmConfig(), "batchop.a", OperatorType.BATCH)
            .map(publication => publication.keyType)
        ).toEqual([KeyType.K1, KeyType.EM, KeyType.ED])
      })

      it("signatureProviderKeyPublications drops every EM and ED row under the default keyTypes, every EM row under [EM], and nothing else", () => {
        const withBoth = Steps.keys.signatureProviderKeyPublications(ssmKmsConfig()),
          withEthereumOnly = Steps.keys.signatureProviderKeyPublications(
            ssmKmsConfig({}, { kms: EthereumOnlyKms })
          ),
          without = Steps.keys.signatureProviderKeyPublications(ssmConfig()),
          custodiedInKms = [KeyType.EM, KeyType.ED]
        expect(
          withBoth.some(publication => custodiedInKms.includes(publication.keyType))
        ).toBe(false)
        expect(withBoth).toEqual(
          without.filter(publication => !custodiedInKms.includes(publication.keyType))
        )
        expect(without.length - withBoth.length).toBe(
          custodiedInKms.length * ssmConfig().batchOperatorCount
        )
        // [EM]: one EM row per batch operator is the whole difference.
        expect(withEthereumOnly).toEqual(
          without.filter(publication => publication.keyType !== KeyType.EM)
        )
        expect(without.length - withEthereumOnly.length).toBe(
          ssmConfig().batchOperatorCount
        )
      })

      it("signatureProviderSecretId is absent for every KMS-custodied curve and still renders the SSM ones", () => {
        const config = ssmKmsConfig(),
          ethereumOnly = ssmKmsConfig({}, { kms: EthereumOnlyKms })
        expect(Steps.keys.signatureProviderSecretId(config, "batchop.a", KeyType.EM)).toBeNull()
        expect(Steps.keys.signatureProviderSecretId(config, "batchop.a", KeyType.ED)).toBeNull()
        expect(Steps.keys.signatureProviderSecretId(config, "batchop.a", KeyType.K1)).toBe(
          "/wire/test/batchop.a/K1"
        )
        expect(
          Steps.keys.signatureProviderSecretId(ethereumOnly, "batchop.a", KeyType.ED)
        ).toBe("/wire/test/batchop.a/ED")
      })
    })

    describe("custodyReference (the public, material-free pointer a listing reports)", () => {
      it("renders SSM:<secretId> and KMS:<region>:<alias>", () => {
        expect(
          Steps.keys.custodyReference({
            type: SignatureProviderType.SSM,
            awsSecretId: "/wire/test/batchop.a/K1"
          })
        ).toBe("SSM:/wire/test/batchop.a/K1")
        expect(
          Steps.keys.custodyReference({
            type: SignatureProviderType.KMS,
            awsKmsRegion: KmsRegion,
            awsKmsKeyId: BatchOperatorAlias
          })
        ).toBe(`KMS:${KmsRegion}:${BatchOperatorAlias}`)
      })

      it("agrees with the ONE renderer for every curve of an SSM + kms cluster", () => {
        const reference = (config: ClusterConfig, keyType: KeyType) =>
          Steps.keys.custodyReference(
            ClusterConfigProvider.custodySource(config, "batchop.a", keyType)
          )
        expect(reference(ssmKmsConfig(), KeyType.EM)).toBe(
          `KMS:${KmsRegion}:${BatchOperatorAlias}`
        )
        expect(reference(ssmKmsConfig(), KeyType.ED)).toBe(
          `KMS:${KmsRegion}:${BatchOperatorSolanaAlias}`
        )
        expect(reference(ssmKmsConfig(), KeyType.K1)).toBe("SSM:/wire/test/batchop.a/K1")
        expect(reference(ssmKmsConfig({}, { kms: EthereumOnlyKms }), KeyType.ED)).toBe(
          "SSM:/wire/test/batchop.a/ED"
        )
      })
    })

    describe("identityPrivateKey (what a publish puts, per curve)", () => {
      const operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH)

      it("selects the wire / ethereum / solana secret by curve", () => {
        expect(Steps.keys.identityPrivateKey(operator, KeyType.K1, operator.label)).toBe(
          operator.wire.privateKey
        )
        expect(Steps.keys.identityPrivateKey(operator, KeyType.EM, operator.label)).toBe(
          operator.ethereum.privateKey
        )
        expect(Steps.keys.identityPrivateKey(operator, KeyType.ED, operator.label)).toBe(
          operator.solana.privateKey
        )
      })

      it("selects a producer's finalizer secret, and names the missing curve otherwise", () => {
        const producer = {
          ...fixtureOperatorAccount("flowprod", OperatorType.PRODUCER),
          wireFinalizer: {
            type: KeyType.BLS as const,
            publicKey: Constants.DEV_BLS_PUBLIC_KEY,
            privateKey: Constants.DEV_BLS_PRIVATE_KEY,
            proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
          }
        }
        expect(Steps.keys.identityPrivateKey(producer, KeyType.BLS, "flowprod")).toBe(
          Constants.DEV_BLS_PRIVATE_KEY
        )
        expect(() =>
          Steps.keys.identityPrivateKey(operator, KeyType.BLS, operator.label)
        ).toThrow(/batchopaaaa has no wireFinalizer key/)
        expect(() =>
          Steps.keys.identityPrivateKey(
            { ...operator, ethereum: undefined },
            KeyType.EM,
            operator.label
          )
        ).toThrow(/batchopaaaa has no ethereum key/)
      })

      it("refuses a curve no identity carries", () => {
        expect(() =>
          Steps.keys.identityPrivateKey(operator, KeyType.R1, operator.label)
        ).toThrow(/batchopaaaa has no R1 key/)
      })
    })
  })

  describe("runGenerateNodeKeys", () => {
    it("under KEY: generates one RANDOM K1 + BLS set per producer node — nothing is derived from a mnemonic", async () => {
      const ctx = fixtureContext(fakeExecutables())
      await Steps.keys.runGenerateNodeKeys(
        ctx,
        null,
        new AbortController().signal
      )
      const { wire, wireFinalizer } = ctx.keyStore.node(0).keys
      expect(wire.privateKey).toMatch(/^PVT_K1_/)
      expect(wire.privateKey).not.toBe(Constants.DEV_K1_PRIVATE_KEY)
      expect(PrivateKey.from(wire.privateKey).toPublic().toString()).toBe(
        wire.publicKey
      )
      expect(wireFinalizer.proofOfPossession).toBe(
        Constants.DEV_BLS_PROOF_OF_POSSESSION
      )
    })

    it("mints a DIFFERENT random K1 for every producer node", async () => {
      const ctx = fixtureContext({
        ...fixtureProducerTopologyOverrides(2, 2),
        ...fakeExecutables()
      })
      await Steps.keys.runGenerateNodeKeys(
        ctx,
        null,
        new AbortController().signal
      )
      expect(ctx.keyStore.node(0).keys.wire.privateKey).not.toBe(
        ctx.keyStore.node(1).keys.wire.privateKey
      )
    })

    it("under SSM: ADOPTS a producer node's already-published keys", async () => {
      installSSMStoreMock()
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY)
      publishEverywhere("/wire/test/node_00/K1", k1.toNativeString())
      publishEverywhere(
        "/wire/test/node_00/BLS",
        PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString()
      )
      const ctx = fixtureContext(ssmConfig(fakeExecutables()))
      await Steps.keys.runGenerateNodeKeys(
        ctx,
        null,
        new AbortController().signal
      )
      expect(ctx.keyStore.node(0).keys.wire.privateKey).toBe(k1.toString())
      expect(ctx.keyStore.node(0).keys.wireFinalizer.privateKey).toBe(
        Constants.DEV_BLS_PRIVATE_KEY
      )
      // Adoption reads; it never writes.
      expect(commandInputs("PutParameter")).toEqual([])
    })
  })

  describe("SSM secret-id round-trip (publication ↔ consumption)", () => {
    const config = ssmConfig({ clusterPath: "/tmp/wire-cluster-roundtrip" }),
      publications = Steps.keys.signatureProviderKeyPublications(config),
      keySourceFor = ClusterConfigProvider.signatureProviderSource(config),
      // An on-chain account that differs from its handle. A secret id rendered
      // from THIS instead of the handle is the defect the suite pins.
      ChainAccount = "acct.x3f9k"

    it("an OPERATOR daemon resolves the very id publication wrote", () => {
      const label = Constants.batchOperatorLabel(0),
        published = publications.find(
          publication =>
            publication.label === label && publication.keyType === KeyType.K1
        )
      expect(published.secretId).toBeDefined()
      expect(keySourceFor(label, KeyType.K1).awsSecretId).toBe(
        published.secretId
      )
    })

    it("a producing node's FINALIZER key resolves the very id publication wrote", () => {
      // The node renders one finalizer provider per hosted ACCOUNT, resolved from that account's
      // own label — never from the node's name, which publishes nothing of its own.
      const label = NodeConfig.plan(config)
        .filter(node => node.role === NodeRole.producer)
        .flatMap(node => node.producers)[0]
      expect(label).toBeDefined()
      const published = publications.find(
        publication =>
          publication.label === label && publication.keyType === KeyType.BLS
      )
      expect(published.secretId).toBeDefined()
      expect(keySourceFor(label, KeyType.BLS).awsSecretId).toBe(
        published.secretId
      )
    })

    it("NEVER resolves an operator's key from its chain account", () => {
      // The regression this pins is silent and expensive: publication writes
      // `/wire/<cluster>/batchop.a/K1` while a consumer rendering from the
      // chain account reads `/wire/<cluster>/acct.x3f9k/K1` — ParameterNotFound
      // at daemon start, invisible under KEY mode (the default), fatal on a
      // real SSM cluster.
      const published = publications.find(
        publication =>
          publication.label === Constants.batchOperatorLabel(0) &&
          publication.keyType === KeyType.K1
      )
      expect(keySourceFor(ChainAccount, KeyType.K1).awsSecretId).not.toBe(
        published.secretId
      )
    })
  })

  describe("runPublishSignatureProviderKey (jest SSM mock — no live AWS)", () => {
    /** The publication descriptor for the fixture's batch-operator K1 key. */
    function operatorK1Publication(version?: string) {
      return {
        publishPhase: Steps.keys.SignatureKeyPublishPhase.afterOperators,
        label: "batchop.a",
        publicationLabel: "batchop.a",
        keyType: KeyType.K1,
        awsRegions: SSMRegions,
        secretId: "/wire/c/batchop.a/K1",
        version
      }
    }

    /** A context whose key store holds the fixture batch operator's wire key. */
    /**
     * A producer ACCOUNT carrying a finalizer key, under its own label.
     *
     * Producer nodes publish nothing of their own — every `--signature-provider` spec a node
     * renders resolves from an ACCOUNT's `publicationLabel` — so a BLS publication is always an
     * operator identity.
     */
    function producerAccountContext(wireFinalizer: WireFinalizerKeyPair) {
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "defproducera",
        publicationLabel: "defproducera",
        account: "defproducera",
        type: OperatorType.PRODUCER,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        },
        wireFinalizer
      })
      return ctx
    }

    function operatorContext() {
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "batchop.a",
        publicationLabel: "batchop.a",
        account: "acct.x3f9k",
        type: OperatorType.BATCH,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        }
      })
      return ctx
    }

    it("PutParameters the operator K1 key's NATIVE string (WIF, not PVT_K1_) to EVERY region", async () => {
      installSSMStoreMock()
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await step.runner(ctx, step.input, new AbortController().signal)
      const puts = commandInputs("PutParameter")
      expect(puts).toHaveLength(SSMRegions.length)
      expect(puts[0]).toEqual({
        Name: "/wire/c/batchop.a/K1",
        Value: PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString(),
        Type: "SecureString",
        // NEVER overwrite — an existing parameter is the account's key identity.
        Overwrite: false
      })
      // K1 native = WIF — never the WIRE PVT_ form.
      expect(puts[0].Value).not.toMatch(/^PVT_/)
    })

    it("re-probes PER REGION and writes NOTHING when every region already holds the id", async () => {
      installSSMStoreMock()
      // The adopted-everywhere case: the create adopted this key, so no region
      // needs it written — but each one is still probed.
      publishEverywhere(
        "/wire/c/batchop.a/K1",
        PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()
      )
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("GetParameter")).toHaveLength(SSMRegions.length)
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("publishes to a region that is BEHIND even when another already has the id", async () => {
      // Region 0 answers with the value; region 1 reports not-found → one put.
      mockSend
        .mockResolvedValueOnce(
          secureStringResponse(
            PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()
          )
        )
        .mockRejectedValueOnce(parameterNotFound("/wire/c/batchop.a/K1"))
        .mockResolvedValueOnce({})
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await step.runner(ctx, step.input, new AbortController().signal)
      // Exactly ONE put — replication would silently break without it.
      expect(commandInputs("PutParameter")).toHaveLength(1)
    })

    it("rides the platform-version tag on the PutParameter itself", async () => {
      installSSMStoreMock()
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication("v4")
        )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")[0].Tags).toEqual([
        { Key: Steps.keys.PlatformVersionTagKey, Value: "v4" }
      ])
    })

    it("omits Tags entirely when the cluster declares no version", async () => {
      installSSMStoreMock()
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")[0]).not.toHaveProperty("Tags")
    })

    it("PutParameters the operator ED key's NATIVE string (base58 64-byte secret)", async () => {
      installSSMStoreMock()
      const ed = PrivateKey.generate(KeyType.ED),
        ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "batchop.a",
        publicationLabel: "batchop.a",
        account: "acct.x3f9k",
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
          publishPhase: Steps.keys.SignatureKeyPublishPhase.afterOperators,
          label: "batchop.a",
          publicationLabel: "batchop.a",
          keyType: KeyType.ED,
          awsRegions: SSMRegions,
          secretId: "/wire/c/batchop.a/ED"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      const put = commandInputs("PutParameter")[0]
      expect(put.Value).toBe(ed.toNativeString())
      expect(put.Value).not.toMatch(/^PVT_/)
    })

    it("PutParameters a producer ACCOUNT's BLS key NATIVE string (PVT_BLS_ IS native)", async () => {
      installSSMStoreMock()
      const ctx = producerAccountContext({
        type: KeyType.BLS,
        publicKey: Constants.DEV_BLS_PUBLIC_KEY,
        privateKey: Constants.DEV_BLS_PRIVATE_KEY,
        proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
      })
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-defproducera-BLS",
        "publish defproducera BLS",
        {},
        {
          publishPhase: Steps.keys.SignatureKeyPublishPhase.beforeNodes,
          label: "defproducera",
          publicationLabel: "defproducera",
          keyType: KeyType.BLS,
          awsRegions: SSMRegions,
          secretId: "/wire/c/defproducera/BLS"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      const put = commandInputs("PutParameter")[0]
      expect(put.Value).toBe(
        PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString()
      )
      // BLS is the one type whose WIRE string IS its native form.
      expect(put.Value).toMatch(/^PVT_BLS_/)
    })

    it("publishes a BLS key whose base64url payload carries an underscore", async () => {
      installSSMStoreMock()
      // A base64url payload can carry `_`; the dev BLS key does not, so only a
      // deliberately-chosen key covers the publish path.
      const candidates = Array.from({ length: 64 }, (_unused, index) =>
          PrivateKey.regenerate(KeyType.BLS, new Uint8Array(32).fill(index))
        ),
        bls = candidates.find(key => key.toString().slice(8).includes("_"))
      expect(bls).toBeDefined()
      const ctx = producerAccountContext({
        type: KeyType.BLS,
        publicKey: bls.toPublic().toString(),
        privateKey: bls.toString(),
        proofOfPossession: bls.proofOfPossessionString
      })
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-defproducera-BLS",
        "publish defproducera BLS",
        {},
        {
          publishPhase: Steps.keys.SignatureKeyPublishPhase.beforeNodes,
          label: "defproducera",
          publicationLabel: "defproducera",
          keyType: KeyType.BLS,
          awsRegions: SSMRegions,
          secretId: "/wire/c/defproducera/BLS"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")[0].Value).toBe(bls.toNativeString())
    })
    it("REFUSES a region whose existing parameter holds a DIFFERENT key — a stale copy is never retained silently", async () => {
      installSSMStoreMock()
      // The canonical stale copy: a producer account's republished K1 after its
      // node's key rotated. Retaining it would abort the daemon's next start.
      const stale = PrivateKey.generate(KeyType.K1).toNativeString(),
        current = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()
      expect(stale).not.toBe(current)
      publishEverywhere("/wire/c/batchop.a/K1", stale)
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await expect(
        step.runner(ctx, step.input, new AbortController().signal)
      ).rejects.toThrow(
        /\/wire\/c\/batchop\.a\/K1 in us-east-1 already holds a DIFFERENT K1 key/
      )
      // Neither overwritten nor "retained": the step fails before any write.
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("REFUSES a parameter whose value is not a key of the curve at all — the parse failure rides as the cause", async () => {
      installSSMStoreMock()
      publishEverywhere("/wire/c/batchop.a/K1", "not-a-private-key")
      const ctx = operatorContext(),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-batchop.a-K1",
          "publish batchop.a K1",
          {},
          operatorK1Publication()
        )
      await expect(
        step.runner(ctx, step.input, new AbortController().signal)
      ).rejects.toThrow(
        /\/wire\/c\/batchop\.a\/K1 in us-east-1 holds a value that is not a K1 private key/
      )
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("REFUSES a publication whose label drifted from the one the account's keys were recorded under", async () => {
      installSSMStoreMock()
      const ctx = producerAccountContext({
          type: KeyType.BLS,
          publicKey: Constants.DEV_BLS_PUBLIC_KEY,
          privateKey: Constants.DEV_BLS_PRIVATE_KEY,
          proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
        }),
        step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          "publish-node_00-BLS",
          "publish defproducera key node_00 BLS",
          {},
          {
            publishPhase: Steps.keys.SignatureKeyPublishPhase.beforeNodes,
            label: "defproducera",
            publicationLabel: "node_00",
            keyType: KeyType.BLS,
            awsRegions: SSMRegions,
            secretId: "/wire/c/node_00/BLS"
          }
        )
      await expect(
        step.runner(ctx, step.input, new AbortController().signal)
      ).rejects.toThrow(
        /defproducera publishes under node_00, but its keys were recorded under defproducera/
      )
      expect(mockSend).not.toHaveBeenCalled()
    })

    it("RETAINS a node's already-published keys for its SOLE producer — no write, and nothing reads the account's own path", async () => {
      installSSMStoreMock()
      const topology = ssmTopologyConfig(1, 1),
        [node] = producerNodesOf(topology),
        [producer] = node.producers,
        k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY),
        bls = PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY),
        ctx = fixtureContext()
      // The node's parameters exist (adopted at generation); its sole producer signs with them.
      publishEverywhere(`/wire/test/${node.name}/K1`, k1.toNativeString())
      publishEverywhere(`/wire/test/${node.name}/BLS`, bls.toNativeString())
      ctx.keyStore.setOperator({
        label: producer,
        publicationLabel: NodeConfig.producerPublicationLabel(node, producer),
        account: producer,
        type: OperatorType.PRODUCER,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: Constants.DEV_BLS_PUBLIC_KEY,
          privateKey: Constants.DEV_BLS_PRIVATE_KEY,
          proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
        }
      })
      const publications = Steps.keys
        .signatureProviderKeyPublications(topology)
        .filter(publication => publication.label === producer)
      expect(publications).toHaveLength(2)
      for (const publication of publications) {
        const step = Steps.keys.planPublishSignatureProviderKey(
          Report.Actor.Sysio,
          `publish-${publication.publicationLabel}-${KeyType[publication.keyType]}`,
          `publish ${producer} key ${publication.publicationLabel}`,
          {},
          publication
        )
        await step.runner(ctx, step.input, new AbortController().signal)
      }
      expect(commandInputs("PutParameter")).toEqual([])
      const probed = commandInputs("GetParameter").map(input => input.Name)
      expect(probed.length).toBe(publications.length * SSMRegions.length)
      expect(probed.every(name => name.startsWith(`/wire/test/${node.name}/`))).toBe(true)
      expect(probed.some(name => name.includes(producer))).toBe(false)
    })

    /** A context whose batch operator also holds outpost keys (EM + ED, both random). */
    async function outpostKeyContext() {
      const ethereum = await KeyGenerator.create(KeyType.EM, keyContext()),
        solana = await KeyGenerator.create(KeyType.ED, keyContext()),
        ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "batchop.a",
        publicationLabel: "batchop.a",
        account: "acct.x3f9k",
        type: OperatorType.BATCH,
        wire: {
          type: KeyType.K1,
          publicKey: Constants.DEV_K1_PUBLIC_KEY,
          privateKey: Constants.DEV_K1_PRIVATE_KEY
        },
        ethereum,
        solana
      })
      return { ctx, ethereum, solana }
    }

    /** The publication descriptor for the fixture batch operator's `keyType` key. */
    function operatorPublication(keyType: KeyType) {
      return {
        ...operatorK1Publication(),
        keyType,
        secretId: `/wire/c/batchop.a/${KeyType[keyType]}`
      }
    }

    it("retains an existing EM parameter that holds this run's key — compared in canonical NATIVE form", async () => {
      installSSMStoreMock()
      const { ctx, ethereum } = await outpostKeyContext()
      publishEverywhere(
        "/wire/c/batchop.a/EM",
        PrivateKey.from(ethereum.privateKey).toNativeString()
      )
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-batchop.a-EM",
        "publish batchop.a EM",
        {},
        operatorPublication(KeyType.EM)
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")).toEqual([])
    })

    it("retains an existing ED parameter that holds this run's key — compared in canonical NATIVE form", async () => {
      installSSMStoreMock()
      const { ctx, solana } = await outpostKeyContext()
      publishEverywhere(
        "/wire/c/batchop.a/ED",
        PrivateKey.from(solana.privateKey).toNativeString()
      )
      const step = Steps.keys.planPublishSignatureProviderKey(
        Report.Actor.Sysio,
        "publish-batchop.a-ED",
        "publish batchop.a ED",
        {},
        operatorPublication(KeyType.ED)
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")).toEqual([])
    })
  })

  describe("operatorKeyTypes / operatorKeyPublications / isPublishedAtBootstrap (a FLOW operator's SSM rows)", () => {
    const config = ssmConfig()

    it("publishes wire K1 + both outpost curves for a batch operator / underwriter, plus a BLS finalizer key for a collateral-backed producer", () => {
      expect(Steps.keys.operatorKeyTypes(OperatorType.BATCH)).toEqual([
        KeyType.K1,
        KeyType.EM,
        KeyType.ED
      ])
      expect(Steps.keys.operatorKeyTypes(OperatorType.UNDERWRITER)).toEqual([
        KeyType.K1,
        KeyType.EM,
        KeyType.ED
      ])
      expect(Steps.keys.operatorKeyTypes(OperatorType.PRODUCER)).toEqual([
        KeyType.K1,
        KeyType.EM,
        KeyType.ED,
        KeyType.BLS
      ])
    })

    it("renders a flow operator's rows under ITS OWN handle, through the renderer the walker uses", () => {
      const publications = Steps.keys.operatorKeyPublications(
        config,
        "depositoraaa",
        OperatorType.PRODUCER
      )
      expect(publications.map(publication => publication.secretId)).toEqual([
        "/wire/test/depositoraaa/K1",
        "/wire/test/depositoraaa/EM",
        "/wire/test/depositoraaa/ED",
        "/wire/test/depositoraaa/BLS"
      ])
      publications.forEach(publication => {
        expect(publication.publishPhase).toBe(
          Steps.keys.SignatureKeyPublishPhase.afterOperators
        )
        expect(publication.awsRegions).toEqual(SSMRegions)
        expect(publication).not.toHaveProperty("privateKey")
      })
      // The walker's own batch-operator rows are the SAME shape — one renderer,
      // so a flow's id and a bootstrap id can never drift apart.
      expect(
        Steps.keys.operatorKeyPublications(
          config,
          "batchop.a",
          OperatorType.BATCH
        )
      ).toEqual(
        Steps.keys
          .signatureProviderKeyPublications(config)
          .filter(publication => publication.label === "batchop.a")
      )
    })

    it("knows which labels the bootstrap publishes itself — a flow's label is never among them", () => {
      expect(
        Steps.keys.isPublishedAtBootstrap(
          config,
          Constants.batchOperatorLabel(0)
        )
      ).toBe(true)
      expect(
        Steps.keys.isPublishedAtBootstrap(config, Constants.underwriterLabel(0))
      ).toBe(false)
      expect(
        Steps.keys.isPublishedAtBootstrap(config, NodeConfig.BiosName)
      ).toBe(true)
      expect(Steps.keys.isPublishedAtBootstrap(config, "depositoraaa")).toBe(
        false
      )
    })
  })

  describe("keyGeneratorContext", () => {
    it("names the build's sys-util and NOTHING else — no clio, no mnemonic, the same on every cluster", () => {
      const ctx = fixtureContext(),
        context = Steps.keys.keyGeneratorContext(ctx)
      expect(context).toEqual({
        sysUtil: Path.join(ctx.config.buildPath, KeyGenerator.SysUtilSubpath)
      })
      expect(Object.keys(context)).toEqual(["sysUtil"])
      // An SSM cluster's context is identical: nothing cluster-scoped rides it.
      expect(Steps.keys.keyGeneratorContext(fixtureContext(ssmConfig()))).toEqual(
        context
      )
    })
  })
})
