import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  AWSAccountName,
  ClusterStateNodeRole,
  findKeyMaterial,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"

import { ethers } from "ethers"
import { ClusterState } from "@wireio/cluster-tool"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { ClusterKeyStore } from "@wireio/cluster-tool/orchestration/outputs"
import {
  ethereumKeyPairFromKmsPublicKey,
  solanaKeyPairFromKmsPublicKey,
  solanaKeypair
} from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"
import { fixtureProducerTopologyOverrides } from "../config/clusterConfigFixture.js"
import { fixtureExternalOutposts } from "../config/resolveEnvironmentFixture.js"
import { fixtureOperatorAccount } from "../orchestration/outputs/operatorAccountFixture.js"

/** One persisted operator record of a raw `cluster-keys.json`, as a test mutates it before re-saving. */
interface RawOperatorRecord {
  account: string
  ethereum: Record<string, unknown>
  solana: Record<string, unknown>
}

/** The raw `cluster-keys.json` document a custody-form test rewrites. */
interface RawClusterKeysDocument {
  nodes: Array<Record<string, unknown>>
  operators: RawOperatorRecord[]
}

/** A fully-keyed batch-operator handle — carries wire + ethereum + solana keys. */
const BatchOperatorLabel = "batchopaaaa"
/** The operator's on-chain account — deliberately distinct from its label. */
const BatchOperatorAccount = "acct.x3f9k"
/**
 * The ONE batch-operator identity every case here seeds and asserts against —
 * a single instance, so its derived EM/ED keys stay stable across the capture /
 * save / load / rehydrate round-trips this suite compares.
 */
const BatchOperator = fixtureOperatorAccount(
  BatchOperatorLabel,
  OperatorType.BATCH,
  BatchOperatorAccount
)

describe("ClusterState", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-state-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A real `ClusterBuildContext` rooted at the temp dir, seeded with a node
   *  key set + a fully-keyed batch-operator account. */
  function seededContext(overrides: Partial<ClusterConfig> = {}) {
    const ctx = fixtureContext({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      walletPath: Path.join(dir, "wallet"),
      ...overrides
    })
    ctx.keyStore.pushNodes({
      index: 0,
      keys: {
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_node0",
          privateKey: "PVT_K1_node0"
        },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: "PUB_BLS_node0",
          privateKey: "PVT_BLS_node0",
          proofOfPossession: "SIG_BLS_node0"
        }
      }
    })
    ctx.keyStore.setOperator(BatchOperator)
    return ctx
  }

  describe("capture", () => {
    it("builds a secret-free snapshot of the planned topology", () => {
      const ctx = seededContext()
      const state = ClusterState.capture(ctx)
      expect(state.nodes.length).toBeGreaterThan(0)
      expect(state.nodes.some(node => node.name === "node_bios")).toBe(true)
      expect(state.walletPath).toBe(ctx.config.walletPath)
      expect(state.anvilStateFile).toContain(ctx.config.dataPath)
      expect(state.solanaLedgerPath).toContain(ctx.config.dataPath)
      // No Solana outpost artifacts were prepared in this fixture.
      expect(state.solanaIdlFile).toBeNull()
    })

    it("carries NO private key material", () => {
      const ctx = seededContext()
      const raw = JSON.stringify(ClusterState.capture(ctx))
      expect(raw).not.toContain("PVT_")
    })

    it("bridges every planned NodeRole onto the persisted ClusterStateNodeRole", () => {
      const ctx = seededContext(),
        planned = NodeConfig.plan(ctx.config),
        persistedRoleFor = new Map(
          ClusterState.capture(ctx).nodes.map(
            node => [node.name, node.role] as const
          )
        ),
        persistedRoleOf = (role: NodeRole) =>
          persistedRoleFor.get(planned.find(node => node.role === role).name)
      expect(persistedRoleOf(NodeRole.bios)).toBe(ClusterStateNodeRole.bios)
      expect(persistedRoleOf(NodeRole.producer)).toBe(
        ClusterStateNodeRole.producer
      )
      // The snapshot records the batch daemon as an operator process.
      expect(persistedRoleOf(NodeRole.batch_operator)).toBe(
        ClusterStateNodeRole.operator
      )
      // An API node keeps its OWN persisted kind: it is neither a producer (no
      // keys, no `resumeProduction`) nor an operator (no daemon args).
      expect(persistedRoleOf(NodeRole.api)).toBe(ClusterStateNodeRole.api)
    })

    it("nulls the anvil state + solana ledger paths in external-outpost mode", () => {
      const ctx = fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        walletPath: Path.join(dir, "wallet"),
        externalOutposts: fixtureExternalOutposts()
      })
      const state = ClusterState.capture(ctx)
      expect(state.anvilStateFile).toBeNull()
      expect(state.solanaLedgerPath).toBeNull()
    })
  })

  describe("save / load round-trip (cluster-state.json)", () => {
    it("round-trips an identical snapshot", () => {
      const ctx = seededContext(),
        state = ClusterState.capture(ctx)
      ClusterState.save(ctx.config, state)
      expect(ClusterState.load(ctx.config)).toEqual(state)
    })

    it("keeps the api node row through the round-trip", () => {
      const ctx = seededContext()
      ClusterState.save(ctx.config, ClusterState.capture(ctx))
      const apiRows = ClusterState.load(ctx.config).nodes.filter(
        node => node.role === ClusterStateNodeRole.api
      )
      // The fixture plans one API node: no producers, no operator identity.
      expect(apiRows).toHaveLength(1)
      expect(apiRows[0].producers).toEqual([])
      expect(apiRows[0].batchOperatorLabel).toBeNull()
      expect(apiRows[0].underwriterLabel).toBeNull()
      expect(apiRows[0].ports).toEqual({
        http: ctx.config.bind.nodeop.ports.api[0].http,
        p2p: ctx.config.bind.nodeop.ports.api[0].p2p
      })
    })

    it("the on-disk file carries no private key material", () => {
      const ctx = seededContext()
      ClusterState.save(ctx.config, ClusterState.capture(ctx))
      const raw = Fs.readFileSync(
        ClusterState.stateFilePath(ctx.config),
        "utf8"
      )
      expect(raw).not.toContain("PVT_")
    })

    it("throws when cluster-state.json is missing", () => {
      const ctx = seededContext()
      expect(() => ClusterState.load(ctx.config)).toThrow(/not found/)
    })
  })

  describe("captureKeys / save / load round-trip (cluster-keys.json)", () => {
    it("round-trips node key sets and every operator's full key set", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      const loaded = ClusterState.loadKeys(ctx.config)
      expect(loaded).toEqual(keys)
      const operator = loaded.operators.find(
        entry => entry.label === BatchOperatorLabel
      )
      // The persisted record keeps BOTH identities distinct.
      expect(operator?.account).toBe(BatchOperatorAccount)
      expect(operator?.ethereum?.address).toBe(BatchOperator.ethereum.address)
      expect(operator?.solana?.publicKey).toBe(BatchOperator.solana.publicKey)
      expect(operator?.wire.privateKey).toBe(`PVT_K1_${BatchOperatorLabel}`)
    })

    it("writes cluster-keys.json with file mode 0600", () => {
      const ctx = seededContext()
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const mode =
        Fs.statSync(ClusterState.keysFilePath(ctx.config)).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it("re-saving over an existing file still enforces 0600", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      Fs.chmodSync(ClusterState.keysFilePath(ctx.config), 0o644)
      ClusterState.saveKeys(ctx.config, keys)
      const mode =
        Fs.statSync(ClusterState.keysFilePath(ctx.config)).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it("throws when cluster-keys.json is missing", () => {
      const ctx = seededContext()
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(/not found/)
    })

  })

  describe("§5.6 — an SSM cluster persists key REFERENCES, never key material", () => {
    /** Every region a key is replicated to (no primary). */
    const SSMRegions = ["us-east-1", "eu-west-1"]

    /** The SSM overrides layered onto the temp-dir fixture. */
    function ssmOverrides(): Partial<ClusterConfig> {
      return {
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

    /** The seeded temp-dir context, resolved under an SSM signature provider. */
    function ssmContext() {
      return seededContext(ssmOverrides())
    }

    it("swaps every privateKey for the awsSecretId its publish step put it under", () => {
      const keys = ClusterState.captureKeys(ssmContext()),
        node = keys.nodes[0],
        operator = keys.operators.find(
          entry => entry.account === BatchOperatorAccount
        )
      // Node keys are keyed by the node NAME — the same `{account}` segment
      // `KeySteps.signatureProviderKeyPublications` publishes them under.
      expect(node.wire.privateKey).toBeUndefined()
      expect(node.wire.awsSecretId).toBe("/wire/test/node_00/K1")
      expect(node.wireFinalizer.awsSecretId).toBe("/wire/test/node_00/BLS")
      // Operator keys are keyed by the DURABLE handle, never the chain account.
      expect(operator?.wire.privateKey).toBeUndefined()
      expect(operator?.wire.awsSecretId).toBe(
        `/wire/test/${BatchOperatorLabel}/K1`
      )
      expect(operator?.ethereum?.awsSecretId).toBe(
        `/wire/test/${BatchOperatorLabel}/EM`
      )
      expect(operator?.solana?.awsSecretId).toBe(
        `/wire/test/${BatchOperatorLabel}/ED`
      )
    })

    // A node's SOLE producer signs and votes with the node's own key set, which
    // is published ONCE under the node. The persisted operator refs and node
    // refs therefore name the SAME parameters — `runClone` ships this file into
    // the external deployment, where it must agree with external-cluster-config's
    // node-keyed refs for the same keys.
    it("keys a node's SOLE producer's refs by its NODE — identical to the node's own refs", () => {
      const ctx = seededContext({
          ...ssmOverrides(),
          ...fixtureProducerTopologyOverrides(1, 1)
        }),
        node = NodeConfig.plan(ctx.config).find(
          planned => planned.role === NodeRole.producer
        ),
        [producer] = node.producers,
        nodeKeys = ctx.keyStore.node(node.index)
      ctx.keyStore.setOperator({
        label: producer,
        publicationLabel: NodeConfig.producerPublicationLabel(node, producer),
        account: producer,
        type: OperatorType.PRODUCER,
        wire: nodeKeys.keys.wire,
        wireFinalizer: nodeKeys.keys.wireFinalizer
      })
      const keys = ClusterState.captureKeys(ctx),
        nodeEntry = keys.nodes.find(entry => entry.index === node.index),
        entry = keys.operators.find(record => record.account === producer)
      expect(entry.wire.awsSecretId).toBe(`/wire/test/${node.name}/K1`)
      expect(entry.wireFinalizer.awsSecretId).toBe(
        `/wire/test/${node.name}/BLS`
      )
      expect(entry.wire.awsSecretId).toBe(nodeEntry.wire.awsSecretId)
      expect(entry.wireFinalizer.awsSecretId).toBe(
        nodeEntry.wireFinalizer.awsSecretId
      )
      expect(entry.wire.publicKey).toBe(nodeEntry.wire.publicKey)
      expect(entry.wireFinalizer.publicKey).toBe(nodeEntry.wireFinalizer.publicKey)
      expect(entry.wire.privateKey).toBeUndefined()
      expect(entry.wireFinalizer.privateKey).toBeUndefined()
    })

    it("keys a SHARED-node producer's refs by its own label — never the node's", () => {
      const ctx = ssmContext(),
        node = NodeConfig.plan(ctx.config).find(
          planned => planned.role === NodeRole.producer
        ),
        [producer] = node.producers,
        nodeKeys = ctx.keyStore.node(node.index)
      expect(node.producers.length).toBeGreaterThan(1)
      ctx.keyStore.setOperator({
        label: producer,
        publicationLabel: NodeConfig.producerPublicationLabel(node, producer),
        account: producer,
        type: OperatorType.PRODUCER,
        wire: nodeKeys.keys.wire,
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: `PUB_BLS_${producer}`,
          privateKey: `PVT_BLS_${producer}`,
          proofOfPossession: `SIG_BLS_${producer}`
        }
      })
      const entry = ClusterState.captureKeys(ctx).operators.find(
        record => record.account === producer
      )
      expect(entry.wire.awsSecretId).toBe(`/wire/test/${producer}/K1`)
      expect(entry.wireFinalizer.awsSecretId).toBe(`/wire/test/${producer}/BLS`)
    })

    it("RETAINS the non-secret per-curve members (BLS proof, EM address)", () => {
      const keys = ClusterState.captureKeys(ssmContext()),
        operator = keys.operators.find(
          entry => entry.account === BatchOperatorAccount
        )
      // ExternalClusterConfigSteps.keyProviderFor + the genesis finalizer key
      // read these regardless of who holds the secret.
      expect(keys.nodes[0].wireFinalizer.proofOfPossession).toBe(
        "SIG_BLS_node0"
      )
      expect(operator?.ethereum?.address).toBe(BatchOperator.ethereum.address)
      expect(keys.nodes[0].wire.publicKey).toBe("PUB_K1_node0")
    })

    it("HARD GATE — the serialized cluster-keys.json carries ZERO key material", () => {
      const ctx = ssmContext()
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const raw = Fs.readFileSync(ClusterState.keysFilePath(ctx.config), "utf8")
      expect(raw).not.toContain("privateKey")
      expect(raw).not.toContain("PVT_")
      // The ONE key-material signature set — never re-spelled here.
      expect(findKeyMaterial(raw)).toEqual([])
    })

    it("round-trips the refs-only payload through the schema", () => {
      const ctx = ssmContext(),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      expect(ClusterState.loadKeys(ctx.config)).toEqual(keys)
    })

    it("KEY mode is unchanged — the plaintext key material still persists", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx)
      expect(keys.nodes[0].wire.privateKey).toBe("PVT_K1_node0")
      expect(keys.nodes[0].wire.awsSecretId).toBeUndefined()
      expect(
        keys.operators.find(entry => entry.account === BatchOperatorAccount)
          ?.wire.privateKey
      ).toBe(`PVT_K1_${BatchOperatorLabel}`)
    })

    it("REJECTS a record carrying BOTH custody forms — that is a leaked secret", () => {
      const ctx = ssmContext()
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        leaked = JSON.parse(Fs.readFileSync(keysFile, "utf8"))
      leaked.nodes[0].wire.privateKey = "PVT_K1_node0"
      Fs.writeFileSync(keysFile, JSON.stringify(leaked))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
    })

    it("REJECTS a record carrying NEITHER custody form — nothing could sign with it", () => {
      const ctx = seededContext()
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        orphaned = JSON.parse(Fs.readFileSync(keysFile, "utf8"))
      delete orphaned.nodes[0].wire.privateKey
      Fs.writeFileSync(keysFile, JSON.stringify(orphaned))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
    })
  })

  describe("an SSM cluster with KMS settings persists its EM / ED keys as KMS REFERENCES", () => {
    /** The ONE region the KMS keys live in — one of the replication regions. */
    const KmsRegion = "us-east-1"
    /** The alias the KMS pattern renders for the fixture batch operator's EM key (no dots to map). */
    const BatchOperatorAlias = `alias/wire/test/${BatchOperatorLabel}/EM`
    /** The alias the KMS pattern renders for the fixture batch operator's ED key. */
    const BatchOperatorSolanaAlias = `alias/wire/test/${BatchOperatorLabel}/ED`

    /** The SSM overrides plus the kms custody block (both custodiable curves unless `keyTypes` narrows it). */
    function ssmKmsOverrides(
      keyTypes: ClusterConfig["signatureProvider"]["kms"]["keyTypes"] = [
        KeyType.EM,
        KeyType.ED
      ]
    ): Partial<ClusterConfig> {
      return {
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: {
            awsRegions: ["us-east-1", "eu-west-1"],
            awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
          },
          kms: {
            awsKeyAliasPattern: "alias/wire/{cluster}/{account}/{keyType}",
            awsRegion: KmsRegion,
            keyTypes
          },
          batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
        },
        awsClusterNodeConfig: {
          account: AWSAccountName.test,
          regions: ["us-east-1", "eu-west-1"],
          ssm: null,
          kms: null
        }
      }
    }

    /** The persisted batch-operator record of a capture under SSM + kms. */
    function capturedOperator(ctx = seededContext(ssmKmsOverrides())) {
      return ClusterState.captureKeys(ctx).operators.find(
        entry => entry.account === BatchOperatorAccount
      )
    }

    it("persists the EM and ED pairs as { awsKmsKeyId, awsKmsRegion } — no awsSecretId, no privateKey — while K1 keeps its SSM ref", () => {
      const operator = capturedOperator()
      expect(operator.ethereum).toEqual({
        type: KeyType.EM,
        publicKey: BatchOperator.ethereum.publicKey,
        address: BatchOperator.ethereum.address,
        awsKmsKeyId: BatchOperatorAlias,
        awsKmsRegion: KmsRegion
      })
      expect(operator.ethereum).not.toHaveProperty("awsSecretId")
      expect(operator.ethereum).not.toHaveProperty("privateKey")
      expect(operator.solana).toEqual({
        type: KeyType.ED,
        publicKey: BatchOperator.solana.publicKey,
        awsKmsKeyId: BatchOperatorSolanaAlias,
        awsKmsRegion: KmsRegion
      })
      expect(operator.solana).not.toHaveProperty("awsSecretId")
      expect(operator.solana).not.toHaveProperty("privateKey")
      expect(operator.wire.awsSecretId).toBe(`/wire/test/${BatchOperatorLabel}/K1`)
      expect(operator.wire).not.toHaveProperty("awsKmsKeyId")
    })

    it("keyTypes [\"EM\"] keeps the ED pair an SSM reference", () => {
      const operator = capturedOperator(seededContext(ssmKmsOverrides([KeyType.EM])))
      expect(operator.ethereum.awsKmsKeyId).toBe(BatchOperatorAlias)
      expect(operator.solana.awsSecretId).toBe(`/wire/test/${BatchOperatorLabel}/ED`)
      expect(operator.solana).not.toHaveProperty("awsKmsKeyId")
    })

    it("persists an in-memory KMS-custodied ED pair (no material at all) the same way, and a KEY-pair record of it round-trips", () => {
      const ctx = seededContext(ssmKmsOverrides()),
        kmsPair = solanaKeyPairFromKmsPublicKey(
          solanaKeypair(BatchOperator.solana).publicKey.toBytes(),
          KmsRegion,
          BatchOperatorSolanaAlias
        )
      ctx.keyStore.setOperator({ ...BatchOperator, solana: kmsPair })
      const operator = capturedOperator(ctx)
      expect(operator.solana).toEqual({
        type: KeyType.ED,
        publicKey: BatchOperator.solana.publicKey,
        awsKmsKeyId: BatchOperatorSolanaAlias,
        awsKmsRegion: KmsRegion
      })
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const store = new ClusterKeyStore()
      ClusterState.rehydrate(store, ClusterState.loadKeys(ctx.config))
      const rehydrated = store.assertOperator(BatchOperatorLabel)
      expect(rehydrated.solana.awsKmsKeyId).toBe(BatchOperatorSolanaAlias)
      expect(rehydrated.solana.awsKmsRegion).toBe(KmsRegion)
      expect(rehydrated.solana.privateKey).toBeUndefined()
    })

    it("REJECTS an ED record carrying BOTH an SSM ref and a KMS ref, or a KMS ref without its region", () => {
      const ctx = seededContext(ssmKmsOverrides())
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        document: RawClusterKeysDocument = JSON.parse(
          Fs.readFileSync(keysFile, "utf8")
        ),
        operator = document.operators.find(
          entry => entry.account === BatchOperatorAccount
        )
      operator.solana.awsSecretId = `/wire/test/${BatchOperatorLabel}/ED`
      Fs.writeFileSync(keysFile, JSON.stringify(document))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
      delete operator.solana.awsSecretId
      delete operator.solana.awsKmsRegion
      Fs.writeFileSync(keysFile, JSON.stringify(document))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
    })

    it("persists an in-memory KMS-custodied pair (no material at all) the same way", () => {
      const ctx = seededContext(ssmKmsOverrides()),
        wallet = ethers.Wallet.createRandom(),
        kmsPair = ethereumKeyPairFromKmsPublicKey(
          ethers.getBytes(
            ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
          ),
          KmsRegion,
          BatchOperatorAlias
        )
      ctx.keyStore.setOperator({ ...BatchOperator, ethereum: kmsPair })
      const operator = capturedOperator(ctx)
      expect(operator.ethereum).toEqual({
        type: KeyType.EM,
        publicKey: kmsPair.publicKey,
        address: wallet.address,
        awsKmsKeyId: BatchOperatorAlias,
        awsKmsRegion: KmsRegion
      })
    })

    it("round-trips the KMS record through saveKeys / loadKeys / rehydrate, with ZERO key material on disk", () => {
      const ctx = seededContext(ssmKmsOverrides()),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      const raw = Fs.readFileSync(ClusterState.keysFilePath(ctx.config), "utf8")
      expect(raw).not.toContain("privateKey")
      expect(findKeyMaterial(raw)).toEqual([])
      expect(raw).toContain(BatchOperatorAlias)
      const loaded = ClusterState.loadKeys(ctx.config)
      expect(loaded).toEqual(keys)
      const store = new ClusterKeyStore()
      ClusterState.rehydrate(store, loaded)
      const rehydrated = store.assertOperator(BatchOperatorLabel)
      expect(rehydrated.ethereum.awsKmsKeyId).toBe(BatchOperatorAlias)
      expect(rehydrated.ethereum.awsKmsRegion).toBe(KmsRegion)
      expect(rehydrated.ethereum.privateKey).toBeUndefined()
      expect(rehydrated.ethereum.address).toBe(BatchOperator.ethereum.address)
    })

    it("REJECTS a KMS record whose region is missing — the two members ride together", () => {
      const ctx = seededContext(ssmKmsOverrides())
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        halved: RawClusterKeysDocument = JSON.parse(
          Fs.readFileSync(keysFile, "utf8")
        ),
        operator = halved.operators.find(
          entry => entry.account === BatchOperatorAccount
        )
      delete operator.ethereum.awsKmsRegion
      Fs.writeFileSync(keysFile, JSON.stringify(halved))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
    })

    it("REJECTS a record carrying BOTH an SSM ref and a KMS ref", () => {
      const ctx = seededContext(ssmKmsOverrides())
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        doubled: RawClusterKeysDocument = JSON.parse(
          Fs.readFileSync(keysFile, "utf8")
        ),
        operator = doubled.operators.find(
          entry => entry.account === BatchOperatorAccount
        )
      operator.ethereum.awsSecretId = `/wire/test/${BatchOperatorLabel}/EM`
      Fs.writeFileSync(keysFile, JSON.stringify(doubled))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(
        /EXACTLY ONE custody form/
      )
    })

    it("a KMS reference is EM-only — a K1 record carrying one is refused", () => {
      const ctx = seededContext(ssmKmsOverrides())
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const keysFile = ClusterState.keysFilePath(ctx.config),
        mislabeled: RawClusterKeysDocument = JSON.parse(
          Fs.readFileSync(keysFile, "utf8")
        )
      mislabeled.nodes[0].wire = {
        type: KeyType.K1,
        publicKey: "PUB_K1_node0",
        awsKmsKeyId: "alias/wire/test/node_00/K1",
        awsKmsRegion: KmsRegion
      }
      Fs.writeFileSync(keysFile, JSON.stringify(mislabeled))
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow()
    })
  })

  describe("rehydrate", () => {
    it("repopulates a fresh ClusterKeyStore from loaded keys", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx),
        store = new ClusterKeyStore()
      ClusterState.rehydrate(store, keys)
      expect(store.node(0).keys.wire.publicKey).toBe("PUB_K1_node0")
      // The store is keyed by the DURABLE handle, never the chain account.
      expect(store.operator(BatchOperatorAccount)).toBeUndefined()
      const operator = store.assertOperator(BatchOperatorLabel)
      expect(operator.account).toBe(BatchOperatorAccount)
      expect(operator.ethereum?.address).toBe(BatchOperator.ethereum.address)
      expect(operator.solana?.publicKey).toBe(BatchOperator.solana.publicKey)
    })
  })
})
