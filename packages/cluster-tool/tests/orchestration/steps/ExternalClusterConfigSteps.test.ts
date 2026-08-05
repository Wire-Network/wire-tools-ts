import Fs from "node:fs"
import Net from "node:net"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  AWSAccountName,
  type AWSClusterNodeConfig,
  type ClusterSignatureProviderConfig,
  ExternalClusterConfigSchemaCodec,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { ClusterState, Constants } from "@wireio/cluster-tool"
import {
  ClusterConfigProvider,
  NodeConfig,
  NodeRole
} from "@wireio/cluster-tool/config"
import {
  ClusterBuild,
  ClusterBuildPhaseGroup,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { PersistedFixture } from "../../config/clusterConfigFixture.js"

const External = Steps.externalClusterConfig,
  signal = new AbortController().signal,
  PortShift = 10_000,
  // Provider overrides for the provider-type-aware emit (Item 1).
  KeyProvider: ClusterSignatureProviderConfig = {
    type: SignatureProviderType.KEY,
    ssm: null
  },
  KiodProvider: ClusterSignatureProviderConfig = {
    type: SignatureProviderType.KIOD,
    ssm: null
  },
  SSMRegions = ["us-east-1", "eu-west-1"],
  SSMSecretIdPattern = "/wire/{cluster}/{account}/{keyType}",
  SSMProvider: ClusterSignatureProviderConfig = {
    type: SignatureProviderType.SSM,
    ssm: { awsRegions: SSMRegions, awsSecretIdPattern: SSMSecretIdPattern }
  },
  // The SOURCE cluster's AWS placement — `{cluster}` renders its ACCOUNT.
  SourceAWSClusterNodeConfig: AWSClusterNodeConfig = {
    account: AWSAccountName.test,
    regions: SSMRegions,
    ssm: null
  },
  // The SSM `{cluster}` create published under — the AWS account, NOT
  // basename(localDir).
  SourceClusterLabel = AWSAccountName.test

/** Deep-clone a bind shape, shifting every numeric port by `delta` (addresses unchanged). */
function shiftPorts(value: unknown, delta: number): unknown {
  if (typeof value === "number") return value + delta
  if (Array.isArray(value)) return value.map(entry => shiftPorts(entry, delta))
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shiftPorts(entry, delta)])
    )
  }
  return value
}

/**
 * A DUP-FREE complete bind: the fixture bind with its one hand-written
 * kiod/batch-node port collision (kiod === pair(2).http) removed — a valid,
 * deterministic external bind that needs no port resolution.
 */
function dupFreeBind() {
  const bind = structuredClone(PersistedFixture.bind)
  bind.kiod.port = 10_700
  return bind
}

/** Every file named `name` beneath `dir` (recursive). */
function findFiles(dir: string, name: string): string[] {
  if (!Fs.existsSync(dir)) return []
  return Fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = Path.join(dir, entry.name)
    return entry.isDirectory()
      ? findFiles(full, name)
      : entry.name === name
        ? [full]
        : []
  })
}

/** Create a listening unix-domain socket at `path` (a non-copyable inode). */
async function listenUnixSocket(path: string): Promise<Net.Server> {
  const server = Net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => resolve())
  })
  return server
}

describe("Steps.externalClusterConfig (create-external-config pipeline)", () => {
  let root: string,
    localDir: string,
    externalDir: string,
    externalBindFile: string,
    externalBind: ReturnType<typeof dupFreeBind>

  /** Seed a local cluster's on-disk state (config in-memory via the fixture). */
  function seedLocalCluster() {
    const ctx = fixtureContext({
      clusterPath: localDir,
      dataPath: Path.join(localDir, "data"),
      walletPath: Path.join(localDir, "wallet")
    })
    Fs.mkdirSync(ctx.config.dataPath, { recursive: true })
    Fs.mkdirSync(ctx.config.walletPath, { recursive: true })
    ctx.keyStore.pushNodes({
      index: 0,
      keys: {
        wire: { type: KeyType.K1, publicKey: "PUB_K1_n0", privateKey: "PVT_K1_n0" },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: "PUB_BLS_n0",
          privateKey: "PVT_BLS_n0",
          proofOfPossession: "SIG_BLS_n0"
        }
      }
    })
    // Seed every operator account the planned topology references (so the
    // captured cluster-keys.json covers cluster-state's operator nodes).
    NodeConfig.plan(ctx.config)
      .filter(node => node.role === NodeRole.operator)
      .forEach(node => {
        const { batchOperatorLabel, underwriterLabel } = node,
          label = batchOperatorLabel ?? underwriterLabel
        ctx.keyStore.setOperator({
          label,
          account: `wireno.${label.replace(/[^a-z1-5]/g, "")}`,
          type:
            batchOperatorLabel != null
              ? OperatorType.BATCH
              : OperatorType.UNDERWRITER,
          wire: {
            type: KeyType.K1,
            publicKey: `PUB_K1_${label}`,
            privateKey: `PVT_K1_${label}`
          },
          ethereum: {
            type: KeyType.EM,
            publicKey: `PUB_EM_${label}`,
            privateKey: `PVT_EM_${label}`,
            address: "0xabc0000000000000000000000000000000000a"
          },
          solana: {
            type: KeyType.ED,
            publicKey: `PUB_ED_${label}`,
            privateKey: `PVT_ED_${label}`
          }
        })
      })
    ClusterState.save(ctx.config, ClusterState.capture(ctx))
    ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
    return ctx
  }

  /**
   * A fresh run context over the local dir with the pipeline params seeded and
   * the given signature-provider type (default KEY).
   */
  function runContext(
    bindFile: string = externalBindFile,
    signatureProvider: ClusterSignatureProviderConfig = PersistedFixture.signatureProvider,
    noDebuggingServer?: boolean
  ) {
    const ctx = fixtureContext({
      clusterPath: localDir,
      dataPath: Path.join(localDir, "data"),
      walletPath: Path.join(localDir, "wallet"),
      signatureProvider,
      // `resolve` makes the AWS placement REQUIRED under SSM (it sources the
      // secret-id `{cluster}`); KEY / KIOD clusters carry none.
      awsClusterNodeConfig:
        signatureProvider.type === SignatureProviderType.SSM
          ? SourceAWSClusterNodeConfig
          : null
    })
    ctx.outputs.set(External.ParamsKey, {
      externalClusterPath: externalDir,
      externalBindConfigFile: bindFile,
      noDebuggingServer
    })
    return ctx
  }

  /** The emitted external-cluster-config.json path. */
  function externalConfigFile(): string {
    return Path.join(externalDir, "external-cluster-config.json")
  }

  /** Run load → clone → rebind → emit under `signatureProvider`; return the emitted config. */
  async function emitWithProvider(
    signatureProvider: ClusterSignatureProviderConfig
  ) {
    const ctx = runContext(externalBindFile, signatureProvider)
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    await External.runEmit(ctx, null, signal)
    return ExternalClusterConfigSchemaCodec.deserialize(
      Fs.readFileSync(externalConfigFile(), "utf-8")
    )
  }

  /**
   * The persisted `cluster-keys.json` record an emitted `accountName` came from.
   * `accountName` is the operator's ON-CHAIN name while the SSM secret id and
   * the fixture's key material are keyed by the DURABLE handle — so every
   * assertion that needs the handle resolves it through this map.
   */
  function keyEntryFor(accountName: string) {
    const entry = ClusterState.loadKeys(runContext().config).operators.find(
      operator => operator.account === accountName
    )
    expect(entry).toBeDefined()
    return entry
  }

  /**
   * Append the two GENESIS identities `ClusterBuild.seedGenesisAccounts` puts in
   * the operator map — the bios node (K1 + BLS) and the bootstrap node owner
   * (K1 alone) — to the persisted cluster keys.
   *
   * They are the reason the emit guard cannot be a flat curve list: they live in
   * the operator map like every batch operator but publish DIFFERENT curves, so
   * a "operators publish K1/EM/ED" set refuses the bios BLS that create really
   * did publish.
   */
  function injectGenesisAccounts() {
    const config = runContext().config,
      keys = ClusterState.loadKeys(config)
    keys.operators.push(
      {
        label: NodeConfig.BiosName,
        account: NodeConfig.BiosProducer,
        type: OperatorType.UNKNOWN,
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_bios",
          privateKey: "PVT_K1_bios"
        },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: "PUB_BLS_bios",
          privateKey: "PVT_BLS_bios",
          proofOfPossession: "SIG_BLS_bios"
        }
      },
      {
        label: Constants.BOOTSTRAP_NODE_OWNER,
        account: Constants.BOOTSTRAP_NODE_OWNER,
        type: OperatorType.UNKNOWN,
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_owner",
          privateKey: "PVT_K1_owner"
        }
      }
    )
    ClusterState.saveKeys(config, keys)
  }

  /**
   * Append the PRODUCER operator accounts `runProducerMaterialization` puts in
   * the operator map — each carrying its hosting NODE's `wire` + `wireFinalizer`
   * (sibling producers on one node share the same pair, by design).
   *
   * Their keys are published under the NODE name (`node_00`), never under the
   * producer account, so the emit side must resolve producer → node or every
   * producer K1 **and BLS** ref is refused.
   *
   * @returns The producer account names seeded, and their hosting node's name.
   */
  function injectProducerAccounts() {
    const config = runContext().config,
      keys = ClusterState.loadKeys(config),
      node = NodeConfig.plan(config).find(
        planned => planned.role === NodeRole.producer
      ),
      nodeKeys = keys.nodes.find(entry => entry.index === node.index)
    node.producers.forEach(producer =>
      keys.operators.push({
        label: producer,
        account: producer,
        type: OperatorType.PRODUCER,
        wire: nodeKeys.wire,
        wireFinalizer: nodeKeys.wireFinalizer
      })
    )
    ClusterState.saveKeys(config, keys)
    return { producers: node.producers, nodeName: node.name }
  }

  /** Inject a `wireFinalizer` key onto the first cluster-keys operator (operators normally carry none). */
  function injectOperatorWireFinalizer() {
    const config = runContext().config,
      keys = ClusterState.loadKeys(config),
      label = keys.operators[0].label,
      account = keys.operators[0].account,
      privateKey = "PVT_BLS_op",
      proofOfPossession = "SIG_BLS_op"
    keys.operators[0].wireFinalizer = {
      type: KeyType.BLS,
      publicKey: "PUB_BLS_op",
      privateKey,
      proofOfPossession
    }
    ClusterState.saveKeys(config, keys)
    return { label, account, privateKey, proofOfPossession }
  }

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "external-config-"))
    localDir = Path.join(root, "local")
    externalDir = Path.join(root, "external")
    externalBindFile = Path.join(root, "external-bind.json")
    seedLocalCluster()
    // A dup-free bind, shifted so the external ports differ from the local ones
    // — the rebind is observable and the stale-port scan has something to catch.
    externalBind = shiftPorts(dupFreeBind(), PortShift) as ReturnType<
      typeof dupFreeBind
    >
    Fs.writeFileSync(externalBindFile, JSON.stringify(externalBind))
  })

  afterEach(() => Fs.rmSync(root, { recursive: true, force: true }))

  it("clones + rebinds + emits + verifies a self-described external config", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    await External.runEmit(ctx, null, signal)
    await External.runVerify(ctx, null, signal)

    expect(Fs.existsSync(externalConfigFile())).toBe(true)
    const emitted = ExternalClusterConfigSchemaCodec.deserialize(
      Fs.readFileSync(externalConfigFile(), "utf-8")
    )
    expect(emitted.wire.epochDurationSec).toBe(ctx.config.epochDurationSec)
    expect(emitted.bindings.kiod.port).toBe(externalBind.kiod.port)
    // `accountName` is the operator's ON-CHAIN name (`account`), never the
    // durable handle the node config and the SSM secret id are keyed by.
    const persisted = ClusterState.loadKeys(ctx.config).operators,
      expectedAccounts = persisted.map(operator => operator.account),
      handles = NodeConfig.plan(ctx.config)
        .filter(node => node.role === NodeRole.operator)
        .map(node => node.batchOperatorLabel ?? node.underwriterLabel)
    expect(emitted.accounts.operators.map(op => op.accountName).sort()).toEqual(
      [...expectedAccounts].sort()
    )
    expect(persisted.map(operator => operator.label).sort()).toEqual(
      [...handles].sort()
    )
    expect(expectedAccounts.sort()).not.toEqual([...handles].sort())

    // The re-rendered config.ini files carry the EXTERNAL bios http port.
    const iniText = findFiles(externalDir, "config.ini")
      .map(file => Fs.readFileSync(file, "utf-8"))
      .join("\n")
    expect(iniText.length).toBeGreaterThan(0)
    expect(iniText).toContain(String(externalBind.nodeop.ports.bios.http))
  })

  it("excludes runtime artifacts (*.pid, logs/, reports/) from the clone", async () => {
    Fs.mkdirSync(Path.join(localDir, "logs"), { recursive: true })
    Fs.writeFileSync(Path.join(localDir, "logs", "cluster.log"), "x")
    Fs.mkdirSync(Path.join(localDir, "reports"), { recursive: true })
    Fs.writeFileSync(Path.join(localDir, "data", "nodeop.pid"), "123")
    await External.runClone(runContext(), null, signal)
    expect(Fs.existsSync(Path.join(externalDir, "logs"))).toBe(false)
    expect(Fs.existsSync(Path.join(externalDir, "reports"))).toBe(false)
    expect(findFiles(externalDir, "nodeop.pid")).toHaveLength(0)
  })

  it("skips stale unix sockets in the clone instead of throwing", async () => {
    // A stopped cluster can leave live/stale socket inodes (kiod.sock, the
    // solana ledger's admin.rpc) that assertClusterStopped's pidfile check
    // misses; Fs.cpSync throws on them, so the clone must filter them out.
    const ledgerDir = Path.join(localDir, "data", "solana-ledger")
    Fs.mkdirSync(ledgerDir, { recursive: true })
    Fs.writeFileSync(Path.join(ledgerDir, "genesis.bin"), "ledger")
    const kiodSocket = await listenUnixSocket(Path.join(localDir, "kiod.sock")),
      adminSocket = await listenUnixSocket(Path.join(ledgerDir, "admin.rpc"))
    try {
      await expect(
        External.runClone(runContext(), null, signal)
      ).resolves.toBeUndefined()
    } finally {
      kiodSocket.close()
      adminSocket.close()
    }
    expect(findFiles(externalDir, "kiod.sock")).toHaveLength(0)
    expect(findFiles(externalDir, "admin.rpc")).toHaveLength(0)
    // a regular sibling of a skipped socket is still copied
    expect(findFiles(externalDir, "genesis.bin")).toHaveLength(1)
  })

  it("preserves 0600 on the cloned cluster-keys.json", async () => {
    await External.runClone(runContext(), null, signal)
    const externalKeys = findFiles(externalDir, "cluster-keys.json")
    expect(externalKeys.length).toBeGreaterThan(0)
    expect(Fs.statSync(externalKeys[0]).mode & 0o777).toBe(0o600)
  })

  it("persists debuggingServerEnabled:false when create-external-config --no-debugging-server is set", async () => {
    const ctx = runContext(externalBindFile, PersistedFixture.signatureProvider, true)
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    const merged = ctx.outputs.assert(External.MergedConfigKey)
    expect(merged.debuggingServerEnabled).toBe(false)
    // …and it round-trips through the persisted external cluster-config.json.
    const reloaded = ClusterConfigProvider.loadSync(
      ClusterConfigProvider.configFilePath(merged)
    )
    expect(reloaded.debuggingServerEnabled).toBe(false)
  })

  it("inherits the local debuggingServerEnabled when --no-debugging-server is absent", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    // The local fixture has debuggingServerEnabled: true → inherited unchanged.
    expect(ctx.outputs.assert(External.MergedConfigKey).debuggingServerEnabled).toBe(true)
  })

  it("Validate composes one verify step per cross-check (fail-fast order)", () => {
    const cluster = ClusterBuild.forContext(runContext()),
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "CreateExternalConfig",
        "cross-validate"
      ),
      phase = External.planValidatePhase(group, Report.Actor.Sysio, {})
    expect(phase.steps.map(step => step.name)).toEqual([
      "load-external-bind",
      "verify-producer-cardinality",
      "verify-batch-cardinality",
      "verify-underwriter-cardinality",
      "verify-node-mapping",
      "verify-operator-accounts",
      "verify-solana-dynamic-range",
      "verify-no-duplicate-ports"
    ])
  })

  it("verify-producer-cardinality rejects an external bind whose node cardinality mismatches", async () => {
    const bind = structuredClone(externalBind)
    bind.nodeop.ports.producers.push({ http: 40_001, p2p: 40_002 })
    const bindFile = Path.join(root, "bad-cardinality.json")
    Fs.writeFileSync(bindFile, JSON.stringify(bind))
    const ctx = runContext(bindFile)
    await External.runLoadExternalBind(ctx, null, signal)
    await expect(
      External.runVerifyProducerCardinality(ctx, signal)
    ).rejects.toThrow(/producers has 2 entries but the local cluster has 1/)
  })

  it("verify-no-duplicate-ports rejects an external bind with duplicate ports", async () => {
    const bind = structuredClone(externalBind)
    bind.anvil.port = bind.kiod.port
    const bindFile = Path.join(root, "dup-ports.json")
    Fs.writeFileSync(bindFile, JSON.stringify(bind))
    const ctx = runContext(bindFile)
    await External.runLoadExternalBind(ctx, null, signal)
    await expect(
      External.runVerifyNoDuplicatePorts(ctx, signal)
    ).rejects.toThrow(/binds the same port twice on one host/)
  })

  it("emits KEY providers with inline plaintext private keys (unchanged)", async () => {
    const emitted = await emitWithProvider(KeyProvider)
    expect(emitted.accounts.operators.length).toBeGreaterThan(0)
    emitted.accounts.operators.forEach(op =>
      op.keyProviders.forEach(provider =>
        expect(provider).toMatchObject({
          providerType: SignatureProviderType.KEY,
          privateKey: `PVT_${KeyType[provider.type]}_${keyEntryFor(op.accountName).label}`
        })
      )
    )
  })

  it("emits SSM providers (replication regions + reconstructed awsSecretId, ZERO plaintext)", async () => {
    const emitted = await emitWithProvider(SSMProvider)
    expect(emitted.accounts.operators.length).toBeGreaterThan(0)
    emitted.accounts.operators.forEach(op =>
      op.keyProviders.forEach(provider => {
        // The emitted id EXACTLY equals what create's KeySteps PutParameter'd.
        expect(provider).toMatchObject({
          providerType: SignatureProviderType.SSM,
          awsRegions: SSMRegions,
          awsSecretId: ClusterConfigProvider.toSecretId(SSMSecretIdPattern, {
            // `{cluster}` is the source cluster's AWS ACCOUNT, not its dir name.
            cluster: SourceClusterLabel,
            // The `{account}` pattern token RENDERS the DURABLE handle — what
            // `KeySteps` PutParameter'd — NOT the emitted on-chain `accountName`.
            account: keyEntryFor(op.accountName).label,
            keyType: KeyType[provider.type]
          })
        })
        expect(provider).not.toHaveProperty("privateKey")
      })
    )
    // No key material anywhere in the emitted file.
    const fileText = Fs.readFileSync(externalConfigFile(), "utf-8")
    expect(fileText).not.toContain("PVT_")
    expect(fileText).not.toContain("privateKey")
  })

  it("emits KIOD providers that are material-less (no keys, no SSM refs)", async () => {
    const emitted = await emitWithProvider(KiodProvider)
    expect(emitted.accounts.operators.length).toBeGreaterThan(0)
    emitted.accounts.operators.forEach(op =>
      op.keyProviders.forEach(provider => {
        expect(provider).toMatchObject({
          providerType: SignatureProviderType.KIOD
        })
        expect(provider.publicKey.length).toBeGreaterThan(0)
        expect(provider).not.toHaveProperty("privateKey")
        expect(provider).not.toHaveProperty("awsSecretId")
        expect(provider).not.toHaveProperty("awsRegions")
      })
    )
    const fileText = Fs.readFileSync(externalConfigFile(), "utf-8")
    expect(fileText).not.toContain("PVT_")
    expect(fileText).not.toContain("privateKey")
  })

  it("preserves a BLS proofOfPossession under KEY", async () => {
    const injected = injectOperatorWireFinalizer(),
      emitted = await emitWithProvider(KeyProvider),
      op = emitted.accounts.operators.find(
        entry => entry.accountName === injected.account
      ),
      blsProvider = op.keyProviders.find(
        provider => provider.type === KeyType.BLS
      )
    expect(blsProvider).toMatchObject({
      providerType: SignatureProviderType.KEY,
      proofOfPossession: injected.proofOfPossession,
      privateKey: injected.privateKey
    })
  })

  it("preserves a BLS proofOfPossession under KIOD (material-less)", async () => {
    const injected = injectOperatorWireFinalizer(),
      emitted = await emitWithProvider(KiodProvider),
      op = emitted.accounts.operators.find(
        entry => entry.accountName === injected.account
      ),
      blsProvider = op.keyProviders.find(
        provider => provider.type === KeyType.BLS
      )
    expect(blsProvider).toMatchObject({
      providerType: SignatureProviderType.KIOD,
      proofOfPossession: injected.proofOfPossession
    })
    expect(blsProvider).not.toHaveProperty("privateKey")
  })

  it("refuses a dangling SSM ref for an operator BLS key (covered-set guard)", async () => {
    injectOperatorWireFinalizer()
    const ctx = runContext(externalBindFile, SSMProvider)
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    await expect(External.runEmit(ctx, null, signal)).rejects.toThrow(
      /not SSM-published/
    )
  })

  // The genesis identities are in the operator map but publish DIFFERENT curves
  // than a batch operator (bios K1+BLS, node owner K1). Emit refused the bios
  // BLS — a parameter create HAD published — so every SSM create-external-config
  // died at Emit. The fixture never seeded them, which is why nothing caught it.
  it("emits the genesis identities' SSM refs (bios K1+BLS, node owner K1)", async () => {
    injectGenesisAccounts()
    const emitted = await emitWithProvider(SSMProvider),
      secretIdsFor = (accountName: string) =>
        emitted.accounts.operators
          .find(op => op.accountName === accountName)
          .keyProviders.flatMap(provider =>
            provider.providerType === SignatureProviderType.SSM
              ? [provider.awsSecretId]
              : []
          )
          .sort()

    // Exactly the ids KeySteps PutParameter'd — `{account}` is the durable
    // HANDLE (`node_bios`), never the on-chain account (`sysio`).
    expect(secretIdsFor(NodeConfig.BiosProducer)).toEqual([
      "/wire/test/node_bios/BLS",
      "/wire/test/node_bios/K1"
    ])
    expect(secretIdsFor(Constants.BOOTSTRAP_NODE_OWNER)).toEqual([
      "/wire/test/wireno/K1"
    ])
  })

  // A producer ACCOUNT carries its hosting node's K1 + BLS (siblings share one
  // pair), but the keys are published under the NODE name. Both refs — and the
  // BLS one especially, it is the finality key — must resolve to the node's
  // published parameter rather than be refused for lacking a producer-account
  // parameter that by design never existed.
  it("resolves producer-account refs (K1 AND BLS) to their node's published ids", async () => {
    const { producers, nodeName } = injectProducerAccounts(),
      emitted = await emitWithProvider(SSMProvider)
    expect(producers.length).toBeGreaterThan(0)
    producers.forEach(producer => {
      const op = emitted.accounts.operators.find(
          entry => entry.accountName === producer
        ),
        secretIds = op.keyProviders
          .flatMap(provider =>
            provider.providerType === SignatureProviderType.SSM
              ? [provider.awsSecretId]
              : []
          )
          .sort()
      expect(secretIds).toEqual([
        `/wire/test/${nodeName}/BLS`,
        `/wire/test/${nodeName}/K1`
      ])
    })
  })

  // The guard is DERIVED from the publication walker, so it must track the
  // walker rather than a curve list: every emitted ref exists in it, and every
  // publication is reachable by the handle+curve the emit side looks up with.
  it("emits only refs the publication walker actually wrote", async () => {
    injectGenesisAccounts()
    injectProducerAccounts()
    const emitted = await emitWithProvider(SSMProvider),
      published = new Set(
        Steps.keys
          .signatureProviderKeyPublications(
            runContext(externalBindFile, SSMProvider).config
          )
          .map(publication => publication.secretId)
      )
    expect(published.size).toBeGreaterThan(0)
    const emittedSecretIds = emitted.accounts.operators.flatMap(op =>
        op.keyProviders.flatMap(provider =>
          provider.providerType === SignatureProviderType.SSM
            ? [provider.awsSecretId]
            : []
        )
      ),
      emittedProviderCount = emitted.accounts.operators.reduce(
        (total, op) => total + op.keyProviders.length,
        0
      )
    // Every emitted provider is an SSM ref…
    expect(emittedSecretIds.length).toBe(emittedProviderCount)
    // …and every one of them names a parameter create actually wrote.
    emittedSecretIds.forEach(secretId =>
      expect(published).toContain(secretId)
    )
  })
})
