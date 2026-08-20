import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { AWSAccountName, SignatureProviderType, type ClusterConfig } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { ClusterConfigProvider, NodeConfig } from "@wireio/cluster-tool/config"
import { EthereumMnemonicKey, EthereumOutpostBootstrapper, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig, PersistedFixture } from "../../config/clusterConfigFixture.js"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/** The `SSMClient` constructor config — region-less means the ambient region. */
interface MockSSMClientConfig {
  region?: string
}

const mockSend = jest.fn()
// `send` is called with the command AND the region its client was constructed
// for: SSM parameters are per-region, so the store below can only mimic AWS if
// it knows which region a get/put is addressed to.
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(({ region }: MockSSMClientConfig = {}) => ({
    send: (command: unknown) => mockSend(command, region ?? "")
  })),
  GetParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
}))

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

/** `clio` output the fake binary prints for a K1 generation. */
const K1_OUTPUT =
  "Private key: PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i\n" +
  "Public key: PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"
/** `sys-util` output the fake binary prints for a BLS generation. */
const BLS_OUTPUT =
  `Private key: ${Constants.DEV_BLS_PRIVATE_KEY}\n` +
  `Public key: ${Constants.DEV_BLS_PUBLIC_KEY}\n` +
  `Proof of Possession: ${Constants.DEV_BLS_PROOF_OF_POSSESSION}`

describe("Steps.keys", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "key-steps-"))
    Fs.mkdirSync(Path.join(dir, "bin"), { recursive: true })
    fakeBinary(Path.join(dir, "clio"), K1_OUTPUT)
    fakeBinary(Path.join(dir, "bin", "sys-util"), BLS_OUTPUT)
  })

  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    mockSend.mockReset()
    ssmStore.clear()
  })

  /** An executable shell script that prints `stdout` regardless of its args. */
  function fakeBinary(file: string, stdout: string): string {
    Fs.writeFileSync(file, `#!/bin/sh\ncat <<'KEYEOF'\n${stdout}\nKEYEOF\n`)
    Fs.chmodSync(file, 0o755)
    return file
  }

  /** Executables + buildPath pointed at this suite's fake clio / sys-util. */
  function fakeExecutables(): Partial<ClusterConfig> {
    return {
      buildPath: dir,
      executables: { ...PersistedFixture.executables, clio: Path.join(dir, "clio") }
    }
  }

  /** The generation context over the fake binaries + the anvil mnemonic. */
  function keyContext(): KeyGenerator.Context {
    return KeyGenerator.context(Path.join(dir, "clio"), dir, EthereumOutpostBootstrapper.AnvilMnemonic)
  }

  it.each(["planGenerateNodeKeys", "planCreateWallet"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.keys[factoryName](Report.Actor.Sysio, factoryName, `key step ${factoryName}`, {})
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )

  /** An SSM cluster fixture: `{cluster}` renders the AWS ACCOUNT, not the dir. */
  function ssmConfig(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
    return fixtureConfig({
      clusterPath: "/tmp/wire-cluster-pubs",
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegions: SSMRegions,
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        }
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.test,
        regions: SSMRegions,
        ssm: null
      },
      ...overrides
    })
  }

  describe("signatureProviderKeyPublications", () => {
    const config = ssmConfig(),
      publications = Steps.keys.signatureProviderKeyPublications(config)

    it("enumerates the GENESIS identity, every producer node, and every operator", () => {
      // Fixture topology: bios K1+BLS (2) + node owner K1 (1) + 1 producer node
      // K1+BLS (2) + (3 batch + 1 underwriter) operators × 3 K1/EM/ED (12) = 17.
      expect(publications).toHaveLength(17)
    })

    it("PUBLISHES the bios keys — under SSM the bios node renders SSM: specs and cannot start without them", () => {
      // The regression this pins: the walker enumerated producer nodes only,
      // while the bios daemon renders `SSM:/…/node_bios/{K1,BLS}` from
      // `node.name`. Nothing wrote those parameters, so the bios node could
      // never start on ANY SSM cluster — first run or thousandth.
      const biosKeys = publications.filter(publication => publication.label === NodeConfig.BiosName)
      expect(biosKeys.map(publication => publication.keyType).sort()).toEqual([KeyType.K1, KeyType.BLS].sort())
      expect(biosKeys.map(publication => publication.secretId)).toEqual(
        expect.arrayContaining([`/wire/test/${NodeConfig.BiosName}/K1`, `/wire/test/${NodeConfig.BiosName}/BLS`])
      )
    })

    it("PUBLISHES the bootstrap node owner's K1 — it signs roa::newuser for every operator", () => {
      const ownerKeys = publications.filter(publication => publication.label === Constants.BOOTSTRAP_NODE_OWNER)
      expect(ownerKeys).toHaveLength(1)
      expect(ownerKeys[0].keyType).toBe(KeyType.K1)
    })

    it("every rendered daemon secret id has a matching publication (the cross-check that catches an omitted identity)", () => {
      // Whatever a node's `--signature-provider` resolves to MUST have been
      // published. This is the invariant, independent of which identities the
      // walker happens to enumerate today.
      const publishedIds = new Set(publications.map(publication => publication.secretId))
      const sourceFor = ClusterConfigProvider.signatureProviderSource(config),
        // Only a PRODUCING node renders `--signature-provider` specs; a
        // batch/underwriter node carries no producers and fetches no node key.
        producingNodes = NodeConfig.plan(config).filter(node => node.producers.length > 0)
      expect(producingNodes.length).toBeGreaterThan(0)
      producingNodes.forEach(node =>
        [KeyType.K1, KeyType.BLS].forEach(keyType =>
          expect(publishedIds).toContain(sourceFor(node.name, keyType).awsSecretId)
        )
      )
    })

    it("keys each secret id by the AWS ACCOUNT, not the cluster-path basename", () => {
      const batchK1 = publications.find(
        publication => publication.label === "batchop.a" && publication.keyType === KeyType.K1
      )
      // `{cluster}` = awsClusterNodeConfig.account (`test`) — the cluster dir is
      // `/tmp/wire-cluster-pubs` and must NOT appear.
      expect(batchK1?.secretId).toBe("/wire/test/batchop.a/K1")
      expect(batchK1?.awsRegions).toEqual(SSMRegions)
      expect(batchK1).not.toHaveProperty("privateKey")
    })

    it("carries no version when the cluster's SSM settings declare none", () => {
      expect(publications.every(publication => publication.version == null)).toBe(true)
    })

    it("renders the OPTIONAL {version} token when the pattern authors it, and carries it as the tag value", () => {
      const versioned = Steps.keys.signatureProviderKeyPublications(
        ssmConfig({
          signatureProvider: {
            type: SignatureProviderType.SSM,
            ssm: {
              awsRegions: SSMRegions,
              awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}/{version}",
              version: "v4"
            }
          }
        })
      )
      const batchK1 = versioned.find(
        publication => publication.label === "batchop.a" && publication.keyType === KeyType.K1
      )
      expect(batchK1?.secretId).toBe("/wire/test/batchop.a/K1/v4")
      expect(batchK1?.version).toBe("v4")
    })

    it("throws on a KEY provider (SSM settings required)", () => {
      expect(() => Steps.keys.signatureProviderKeyPublications(fixtureConfig())).toThrow(
        /SSM signature provider requires ssm settings/
      )
    })

    it("throws when an SSM cluster carries no awsClusterNodeConfig", () => {
      expect(() => Steps.keys.signatureProviderKeyPublications(ssmConfig({ awsClusterNodeConfig: null }))).toThrow(
        /requires awsClusterNodeConfig/
      )
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
      // Genesis (bios K1+BLS, node owner K1) + 1 producer node (K1+BLS).
      // The bios entries MUST be here and not in the operator phase: that phase
      // composes after BiosNode has already started, so publishing them there
      // would leave the bios daemon fetching parameters that do not yet exist.
      expect(phase.steps.map(step => step.name)).toEqual([
        "publish-node_bios-K1",
        "publish-node_bios-BLS",
        "publish-wireno-K1",
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
        Steps.keys.SignatureKeyPublishPhase.afterOperators
      )
      // (3 batch + 1 underwriter) × (K1 + EM + ED) = 12; no node publications.
      expect(phase.steps).toHaveLength(12)
      expect(phase.steps.every(step => !step.name.startsWith("publish-node_"))).toBe(true)
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
      expect(Steps.keys.signatureProviderSecretId(ssmConfig(), "batchop.a", KeyType.EM)).toBe("/wire/test/batchop.a/EM")
    })

    it("is absent under KEY — there is nothing to adopt", () => {
      expect(Steps.keys.signatureProviderSecretId(fixtureConfig(), "batchop.a", KeyType.EM)).toBeNull()
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
      // The fake clio would have produced a DIFFERENT key — adoption must win.
      expect(adopted.privateKey).not.toContain("2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i")
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
      expect(created.privateKey).toBe("PVT_K1_2bfGi9rYsXQSXXTvJbDAPhHLQUojjaNLomdm3cEJ1XTdfThJ4i")
      // Every region was probed before falling back to generation.
      expect(commandInputs("GetParameter").map(input => input.Name)).toEqual(
        SSMRegions.map(() => "/wire/test/batchop.a/K1")
      )
    })

    it("adopts a BLS key WITH its proof of possession", async () => {
      installSSMStoreMock()
      publishEverywhere("/wire/test/node_00/BLS", PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString())
      const adopted = await Steps.keys.adoptOrCreateSignatureProviderKey(
        ssmConfig(fakeExecutables()),
        KeyType.BLS,
        "node_00",
        keyContext()
      )
      expect(adopted.proofOfPossession).toBe(Constants.DEV_BLS_PROOF_OF_POSSESSION)
    })

    it("HARD-FAILS when two regions hold different values for the same id", async () => {
      mockSend
        .mockResolvedValueOnce(secureStringResponse(PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()))
        .mockResolvedValueOnce(secureStringResponse(PrivateKey.generate(KeyType.K1).toNativeString()))
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

  describe("ethereumMnemonic (D14 — never the published anvil phrase under SSM)", () => {
    it("falls back to the anvil mnemonic under KEY / KIOD so flows stay byte-identical", () => {
      expect(Steps.keys.ethereumMnemonic(fixtureContext())).toBe(EthereumOutpostBootstrapper.AnvilMnemonic)
    })

    it("reads the cluster-scoped phrase once a run has generated one", () => {
      const ctx = fixtureContext(),
        phrase = ethers.Mnemonic.fromEntropy(ethers.randomBytes(32)).phrase
      ctx.outputs.set(EthereumMnemonicKey, phrase)
      expect(Steps.keys.ethereumMnemonic(ctx)).toBe(phrase)
    })
  })

  describe("runGenerateNodeKeys", () => {
    it("under KEY: generates node keys and leaves the anvil mnemonic in place", async () => {
      const ctx = fixtureContext(fakeExecutables())
      await Steps.keys.runGenerateNodeKeys(ctx, null, new AbortController().signal)
      expect(ctx.outputs.get(EthereumMnemonicKey)).toBeNull()
      expect(Steps.keys.ethereumMnemonic(ctx)).toBe(EthereumOutpostBootstrapper.AnvilMnemonic)
      expect(ctx.keyStore.node(0).keys.wire.privateKey).toMatch(/^PVT_K1_/)
      expect(ctx.keyStore.node(0).keys.wireFinalizer.proofOfPossession).toBe(Constants.DEV_BLS_PROOF_OF_POSSESSION)
    })

    it("under SSM: mints a cluster-scoped mnemonic into ctx.outputs (never the config)", async () => {
      installSSMStoreMock()
      const ctx = fixtureContext(ssmConfig(fakeExecutables()))
      await Steps.keys.runGenerateNodeKeys(ctx, null, new AbortController().signal)
      const phrase = ctx.outputs.get(EthereumMnemonicKey)
      expect(phrase).not.toBe(EthereumOutpostBootstrapper.AnvilMnemonic)
      // 32 bytes of entropy → the 24-word BIP-39 form, and a REAL phrase.
      expect(phrase.split(" ")).toHaveLength(24)
      expect(ethers.Mnemonic.fromPhrase(phrase).phrase).toBe(phrase)
      expect(JSON.stringify(ctx.config)).not.toContain(phrase)
    })

    it("under SSM: ADOPTS a producer node's already-published keys", async () => {
      installSSMStoreMock()
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY)
      publishEverywhere("/wire/test/node_00/K1", k1.toNativeString())
      publishEverywhere("/wire/test/node_00/BLS", PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString())
      const ctx = fixtureContext(ssmConfig(fakeExecutables()))
      await Steps.keys.runGenerateNodeKeys(ctx, null, new AbortController().signal)
      expect(ctx.keyStore.node(0).keys.wire.privateKey).toBe(k1.toString())
      expect(ctx.keyStore.node(0).keys.wireFinalizer.privateKey).toBe(Constants.DEV_BLS_PRIVATE_KEY)
      // Adoption reads; it never writes.
      expect(commandInputs("PutParameter")).toEqual([])
    })
  })

  describe("SSM secret-id round-trip (publication ↔ consumption)", () => {
    const config = ssmConfig({ clusterPath: "/tmp/wire-cluster-roundtrip" }),
      publications = Steps.keys.signatureProviderKeyPublications(config),
      keySourceFor = ClusterConfigProvider.signatureProviderSource(config),
      // Opaque, node-owner-generated, and only in existence mid-build. A secret
      // id rendered from THIS is the exact defect present on master.
      GeneratedAccount = "wireno.x3f9k"

    it("an OPERATOR daemon resolves the very id publication wrote", () => {
      const label = Constants.batchOperatorLabel(0),
        published = publications.find(publication => publication.label === label && publication.keyType === KeyType.K1)
      expect(published.secretId).toBeDefined()
      expect(keySourceFor(label, KeyType.K1).awsSecretId).toBe(published.secretId)
    })

    it("a PRODUCER node resolves the very id publication wrote", () => {
      const published = publications.find(
        publication => publication.source === Steps.keys.SignatureKeySource.node && publication.keyType === KeyType.BLS
      )
      expect(published.secretId).toBeDefined()
      expect(keySourceFor(published.label, KeyType.BLS).awsSecretId).toBe(published.secretId)
    })

    it("NEVER resolves an operator's key from its generated chain account", () => {
      // The regression this pins is silent and expensive: publication writes
      // `/wire/<cluster>/batchop.a/K1` while a consumer rendering from the
      // chain account reads `/wire/<cluster>/wireno.x3f9k/K1` — ParameterNotFound
      // at daemon start, invisible under KEY mode (the default), fatal on a
      // real SSM cluster.
      const published = publications.find(
        publication => publication.label === Constants.batchOperatorLabel(0) && publication.keyType === KeyType.K1
      )
      expect(keySourceFor(GeneratedAccount, KeyType.K1).awsSecretId).not.toBe(published.secretId)
    })
  })

  describe("runPublishSignatureProviderKey (jest SSM mock — no live AWS)", () => {
    /** The publication descriptor for the fixture's batch-operator K1 key. */
    function operatorK1Publication(version?: string) {
      return {
        source: Steps.keys.SignatureKeySource.operator,
        nodeIndex: 0,
        publishPhase: Steps.keys.SignatureKeyPublishPhase.afterOperators,
        label: "batchop.a",
        keyType: KeyType.K1,
        awsRegions: SSMRegions,
        secretId: "/wire/c/batchop.a/K1",
        version
      }
    }

    /** A context whose key store holds the fixture batch operator's wire key. */
    function operatorContext() {
      const ctx = fixtureContext()
      ctx.keyStore.setOperator({
        label: "batchop.a",
        publicationLabel: "batchop.a",
        account: "wireno.x3f9k",
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
      publishEverywhere("/wire/c/batchop.a/K1", PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString())
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
        .mockResolvedValueOnce(secureStringResponse(PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY).toNativeString()))
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
      expect(commandInputs("PutParameter")[0].Tags).toEqual([{ Key: Steps.keys.PlatformVersionTagKey, Value: "v4" }])
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
        account: "wireno.x3f9k",
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
          publishPhase: Steps.keys.SignatureKeyPublishPhase.afterOperators,
          label: "batchop.a",
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

    it("PutParameters a producer-node BLS key's NATIVE string (PVT_BLS_ IS native)", async () => {
      installSSMStoreMock()
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
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
          publishPhase: Steps.keys.SignatureKeyPublishPhase.beforeNodes,
          label: "node_00",
          keyType: KeyType.BLS,
          awsRegions: SSMRegions,
          secretId: "/wire/c/node_00/BLS"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      const put = commandInputs("PutParameter")[0]
      expect(put.Value).toBe(PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY).toNativeString())
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
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          wire: {
            type: KeyType.K1,
            publicKey: Constants.DEV_K1_PUBLIC_KEY,
            privateKey: Constants.DEV_K1_PRIVATE_KEY
          },
          wireFinalizer: {
            type: KeyType.BLS,
            publicKey: bls.toPublic().toString(),
            privateKey: bls.toString(),
            proofOfPossession: bls.proofOfPossessionString
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
          publishPhase: Steps.keys.SignatureKeyPublishPhase.beforeNodes,
          label: "node_00",
          keyType: KeyType.BLS,
          awsRegions: SSMRegions,
          secretId: "/wire/c/node_00/BLS"
        }
      )
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(commandInputs("PutParameter")[0].Value).toBe(bls.toNativeString())
    })
  })
})
