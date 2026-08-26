import Fs from "node:fs"
import Net from "node:net"
import Os from "node:os"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Base58, KeyType } from "@wireio/sdk-core"
import {
  AWSAccountName,
  type AWSClusterNodeConfig,
  type ClusterConfig,
  ClusterDeploymentKind,
  ClusterFiles,
  type ClusterSignatureProviderConfig,
  DefaultChainStateDbSizeMb,
  ExternalClusterConfigSchemaCodec,
  type ExternalOutpostConfig,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { ClusterState, Constants } from "@wireio/cluster-tool"
import {
  AnvilProcess,
  DatabaseMapMode,
  NodeopProcess
} from "@wireio/cluster-tool/cluster/processes"
import {
  AnvilEthereumTransactionPolicyConfig,
  ClusterConfigProvider,
  DaemonConfig,
  NodeConfig,
  NodeRole,
  StartScriptRenderer
} from "@wireio/cluster-tool/config"
import {
  ClusterBuild,
  ClusterBuildPhaseGroup,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import { OperatorDaemonTool } from "@wireio/cluster-tool/tools/wire"
import {
  keyPairFromPrivate,
  StartScriptVariable,
  toDialAddress,
  toRelocatableToken,
  toURL
} from "@wireio/cluster-tool/utils"
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

/** The three SHARED-25 deadline flags, exactly as `buildArgs` emits them. */
const MaxTransactionTimeFlag = "--max-transaction-time",
  AbiSerializerMaxTimeFlag = "--abi-serializer-max-time-ms",
  HttpMaxResponseTimeFlag = "--http-max-response-time-ms"
/** The ini spelling of {@link MaxTransactionTimeFlag} (nodeop drops the `--`). */
const IniMaxTransactionTimeKey = MaxTransactionTimeFlag.replace("--", "")
/** The SHARED-31 chain-state DB size flag, exactly as `buildArgs` emits it. */
const ChainStateDbSizeFlag = "--chain-state-db-size-mb"

/** A live (non-anvil) EVM chain id — proves the anvil default is not assumed. */
const ExternalChainId = 11_155_111
/** An authoritative ETH outpost endpoint no local binding could describe. */
const ExternalEthereumRpcUrl = "https://ethereum-rpc.external.example/"
/** An authoritative SOL outpost endpoint no local binding could describe. */
const ExternalSolanaRpcUrl = "https://solana-rpc.external.example/"

/**
 * The deployed ETH outpost addresses the operator daemons' argv resolves
 * through — every key `OperatorDaemonTool.assertAddress` demands (batch reads
 * OPP + OPPInbound, underwriter reads OperatorRegistry + ReserveManager).
 */
const OutpostAddresses = {
  OPP: "0x1111111111111111111111111111111111111111",
  OPPInbound: "0x2222222222222222222222222222222222222222",
  OperatorRegistry: "0x3333333333333333333333333333333333333333",
  ReserveManager: "0x4444444444444444444444444444444444444444"
}

/** The one hardhat artifact the ABI generation needs (`ethereumAbiFiles.length > 0`). */
const AbiContractName = OperatorDaemonTool.EthereumAbiContractNames[0]

/** Filename of the deployed ETH outpost address map, in its canonical dataPath home. */
const OutpostAddressFilename = "outpost-addrs.json"
/** Subpath (under the cluster data dir) the ETH outpost deploy publishes into. */
const EthereumDeploymentsSubpath = "ethereum-deployments"

/**
 * A FIXED `liqsol_core` program keypair — deterministic so the base58 program
 * id frozen into every operator daemon's argv is identical on every run (a
 * generated id is a fresh random string inside the Verify stale-port scan's
 * search space).
 */
function programKeypair(): Keypair {
  return Keypair.fromSeed(new Uint8Array(SolanaSeedLength).fill(SolanaSeedByte))
}
/** ed25519 seed length (bytes) for {@link programKeypair}. */
const SolanaSeedLength = 32
/** The single byte {@link programKeypair}'s seed repeats. */
const SolanaSeedByte = 7

/**
 * A FIXED per-operator EM secret — 32 bytes of one repeated value, so the ETH
 * signature-provider spec an operator daemon's `start.sh` carries is identical
 * on every run.
 *
 * REAL key material is mandatory here, not decorative: `toSignatureProviderEM`
 * uncompresses the stored public key (`PublicKey.from`), so a synthetic
 * `PUB_EM_<label>` placeholder throws `Invalid Base58 character encountered`
 * the moment the operator daemons' argv is built.
 *
 * @param index - Zero-based operator index.
 * @returns The chain-native (`0x`-hex) secp256k1 secret.
 */
function ethereumPrivateKey(index: number): string {
  return `0x${(index + 1).toString(16).padStart(2, "0").repeat(EthereumSecretLength)}`
}
/** secp256k1 secret length (bytes). */
const EthereumSecretLength = 32

/**
 * A FIXED per-operator ED secret — the base58 of a seeded ed25519 keypair's
 * 64-byte secret, the chain-native form `keyPairFromPrivate` parses. Real
 * material for the same reason as {@link ethereumPrivateKey}
 * (`toSignatureProviderED` reads the stored public key through `PublicKey.from`).
 *
 * @param index - Zero-based operator index.
 * @returns The chain-native (base58) ed25519 secret.
 */
function solanaPrivateKey(index: number): string {
  return Base58.encode(
    Keypair.fromSeed(new Uint8Array(SolanaSeedLength).fill(index + 1)).secretKey
  )
}

/** The generated OPP outpost IDL, carrying every daemon-invoked instruction. */
function outpostIdl(programId: string) {
  return {
    address: programId,
    metadata: { name: SolanaOutpostProgramTool.ProgramName },
    instructions: OperatorDaemonTool.RequiredSolanaIdlInstructions.map(name => ({
      name
    }))
  }
}

/** Write `value` as JSON at `file`, creating its directory. */
function writeJsonFile(file: string, value: unknown): void {
  Fs.mkdirSync(Path.dirname(file), { recursive: true })
  Fs.writeFileSync(file, JSON.stringify(value))
}

/** Trailing shell line-continuation the renderer appends to every argv word. */
const ArgvContinuation = " \\"
/** Indent the renderer prefixes every argv word with. */
const ArgvIndent = "  "

/**
 * The argv a rendered `start.sh` execs — one shell word per continuation line,
 * with a fully single-quoted literal unwrapped to its raw value. A RELOCATED
 * word (`"$CLUSTER_DIR"'/data/…'`) is kept verbatim rather than dropped, so
 * flag→value adjacency survives.
 *
 * @param file - Absolute path of the emitted `start.sh`.
 * @returns The rendered argv, in order.
 */
function startScriptArgv(file: string): string[] {
  return Fs.readFileSync(file, "utf-8")
    .split("\n")
    .filter(
      line => line.startsWith(ArgvIndent) && line.endsWith(ArgvContinuation)
    )
    .map(line => line.slice(0, -ArgvContinuation.length).trim())
    .map(word =>
      word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1) : word
    )
}

/** The value following `flag` in a rendered argv (each occurrence). */
function argvValuesOf(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1]] : []))
}

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
    ethereumPath: string,
    solanaPath: string,
    externalBindFile: string,
    externalBind: ReturnType<typeof dupFreeBind>

  /**
   * The cluster-tree AND sibling-repo roots every context in this suite is
   * aimed at. `PersistedFixture` pins `ethereumPath` / `solanaPath` at absolute
   * NON-EXISTENT roots (`/eth`, `/sol`); the Rebind runs
   * `OperatorDaemonTool.runArtifactPreparation`, which reads real files under
   * both, so they must land in the sandbox alongside the cluster dirs.
   */
  function sandboxPaths(): Partial<ClusterConfig> {
    return {
      clusterPath: localDir,
      dataPath: Path.join(localDir, "data"),
      walletPath: Path.join(localDir, "wallet"),
      ethereumPath,
      solanaPath
    }
  }

  /**
   * Seed every artifact `OperatorDaemonTool.runArtifactPreparation` asserts on,
   * so the Rebind EMITS the daemon start scripts instead of warn-skipping them:
   *
   * 1. the deployed ETH outpost address map, in the per-cluster deployments dir;
   * 2. one hardhat artifact in the wire-ethereum checkout (the ABI source);
   * 3. the committed `liqsol_core` program keypair (the program id source);
   * 4. the generated IDL, carrying every daemon-invoked instruction.
   *
   * All four are pure `Fs`/`JSON.parse` reads — no binaries, no network.
   */
  function seedOutpostArtifacts() {
    writeJsonFile(
      Path.join(
        localDir,
        "data",
        EthereumDeploymentsSubpath,
        OutpostAddressFilename
      ),
      OutpostAddresses
    )
    writeJsonFile(
      Path.join(
        ethereumPath,
        "artifacts",
        "contracts",
        "outpost",
        `${AbiContractName}.sol`,
        `${AbiContractName}.json`
      ),
      { abi: [] }
    )
    writeJsonFile(SolanaOutpostProgramTool.programKeypairFile(solanaPath), [
      ...programKeypair().secretKey
    ])
    writeJsonFile(
      SolanaOutpostProgramTool.programIdlFile(solanaPath),
      outpostIdl(programKeypair().publicKey.toBase58())
    )
  }

  /**
   * An ALREADY-DEPLOYED (remote) outpost description whose per-chain `rpcUrl` is
   * AUTHORITATIVE — the D6 case no bind config can express. Seeds both halves a
   * real external cluster carries by the time it is cloned:
   *
   *  - the SOURCE files the config references, OUTSIDE the cluster tree (Clone
   *    copies them in, Rebind re-points the refs at the in-tree copies), and
   *  - the MATERIALIZED `dataPath` layout `ExternalOutpostSteps.runMaterialize`
   *    wrote at create time, which the Rebind's `runPublishArtifacts` arm reads
   *    to build the operator daemon args.
   *
   * @returns The external-outpost config to seed onto the source cluster.
   */
  function seedExternalOutposts(): ExternalOutpostConfig {
    const sourcePath = Path.join(root, "external-outpost"),
      addressFile = Path.join(sourcePath, OutpostAddressFilename),
      abiFile = Path.join(sourcePath, `${AbiContractName}.json`),
      idlFile = Path.join(sourcePath, OperatorDaemonTool.SolanaIdlFilename),
      idl = outpostIdl(programKeypair().publicKey.toBase58()),
      abi = {
        contractName: AbiContractName,
        address: OutpostAddresses.OPP,
        abi: []
      },
      dataPath = Path.join(localDir, "data")
    writeJsonFile(addressFile, OutpostAddresses)
    writeJsonFile(abiFile, abi)
    writeJsonFile(idlFile, idl)
    writeJsonFile(
      Path.join(
        dataPath,
        OperatorDaemonTool.EthereumAbiSubpath,
        `${AbiContractName}.json`
      ),
      abi
    )
    writeJsonFile(
      Path.join(
        dataPath,
        OperatorDaemonTool.SolanaIdlSubpath,
        OperatorDaemonTool.SolanaIdlFilename
      ),
      idl
    )
    return {
      ethereum: {
        addressFile,
        abiFiles: [abiFile],
        chainId: ExternalChainId,
        rpcUrl: ExternalEthereumRpcUrl
      },
      solana: { idlFile, rpcUrl: ExternalSolanaRpcUrl }
    }
  }

  /** The first BATCH-OPERATOR node planned by `config` (the daemon under test). */
  function assertBatchOperatorNode(config: ClusterConfig): NodeConfig {
    const node = NodeConfig.plan(config).find(
      planned => planned.role === NodeRole.batch_operator
    )
    expect(node).toBeDefined()
    return node
  }

  /** The ON-CHAIN account a durable operator handle resolves to in cluster-keys. */
  function assertOperatorAccount(config: ClusterConfig, label: string): string {
    const entry = ClusterState.loadKeys(config).operators.find(
      operator => operator.label === label
    )
    expect(entry).toBeDefined()
    return entry.account
  }

  /** Seed a local cluster's on-disk state (config in-memory via the fixture). */
  function seedLocalCluster() {
    const ctx = fixtureContext(sandboxPaths())
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
      .filter(node => NodeConfig.isOperatorRole(node.role))
      .forEach((node, index) => {
        const { batchOperatorLabel, underwriterLabel } = node,
          label = batchOperatorLabel ?? underwriterLabel
        ctx.keyStore.setOperator({
          label,
          publicationLabel: label,
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
          // EM / ED are REAL, deterministic pairs — the operator daemons'
          // outpost signature-provider specs parse both stored public keys.
          ethereum: keyPairFromPrivate(KeyType.EM, ethereumPrivateKey(index)),
          solana: keyPairFromPrivate(KeyType.ED, solanaPrivateKey(index))
        })
      })
    ClusterState.save(ctx.config, ClusterState.capture(ctx))
    ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
    return ctx
  }

  /**
   * A fresh run context over the local dir with the pipeline params seeded and
   * the given signature-provider type (default KEY). `configOverrides` replaces
   * further top-level fixture fields (typed by `ClusterConfig`, applied last).
   */
  function runContext(
    bindFile: string = externalBindFile,
    signatureProvider: ClusterSignatureProviderConfig = PersistedFixture.signatureProvider,
    noDebuggingServer?: boolean,
    externalOutposts: ExternalOutpostConfig = null,
    configOverrides: Partial<ClusterConfig> = {}
  ) {
    const ctx = fixtureContext({
      ...sandboxPaths(),
      externalOutposts,
      signatureProvider,
      // `resolve` makes the AWS placement REQUIRED under SSM (it sources the
      // secret-id `{cluster}`); KEY / KIOD clusters carry none.
      awsClusterNodeConfig:
        signatureProvider.type === SignatureProviderType.SSM
          ? SourceAWSClusterNodeConfig
          : null,
      ...configOverrides
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
   * The persisted key pair an emitted provider was rendered from — the record
   * for `accountName` matched on the provider's curve.
   *
   * @param accountName - The emitted account's ON-CHAIN name.
   * @param keyType - The provider's curve.
   * @returns The stored pair for that account + curve.
   */
  function persistedKeyPair(accountName: string, keyType: KeyType) {
    const entry = keyEntryFor(accountName),
      pair = [
        entry.wire,
        entry.wireFinalizer,
        entry.ethereum,
        entry.solana
      ].find(candidate => candidate != null && candidate.type === keyType)
    expect(pair).toBeDefined()
    return pair
  }

  /**
   * The SSM id `create` publishes a label's curve under. Injected records use
   * SSM CUSTODY FORM — `awsSecretId`, never `privateKey` — because that is what
   * a real SSM create persists (`ClusterState.keyCustodyFor`), and the schema
   * admits exactly one custody form. Injecting KEY-shaped records under an SSM
   * provider is a shape no cluster ever produces, and it is what hid the
   * producer-ref defect.
   */
  function secretId(label: string, keyType: KeyType): string {
    return `/wire/${SourceClusterLabel}/${label}/${KeyType[keyType]}`
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
        publicationLabel: NodeConfig.BiosName,
        account: NodeConfig.BiosProducer,
        type: OperatorType.UNKNOWN,
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_bios",
          awsSecretId: secretId(NodeConfig.BiosName, KeyType.K1)
        },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: "PUB_BLS_bios",
          proofOfPossession: "SIG_BLS_bios",
          awsSecretId: secretId(NodeConfig.BiosName, KeyType.BLS)
        }
      },
      {
        label: Constants.BOOTSTRAP_NODE_OWNER,
        publicationLabel: Constants.BOOTSTRAP_NODE_OWNER,
        account: Constants.BOOTSTRAP_NODE_OWNER,
        type: OperatorType.UNKNOWN,
        wire: {
          type: KeyType.K1,
          publicKey: "PUB_K1_owner",
          awsSecretId: secretId(Constants.BOOTSTRAP_NODE_OWNER, KeyType.K1)
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
        publicationLabel: node.name,
        account: producer,
        type: OperatorType.PRODUCER,
        wire: {
          type: KeyType.K1,
          publicKey: nodeKeys.wire.publicKey,
          awsSecretId: secretId(node.name, KeyType.K1)
        },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: nodeKeys.wireFinalizer.publicKey,
          proofOfPossession: nodeKeys.wireFinalizer.proofOfPossession,
          awsSecretId: secretId(node.name, KeyType.BLS)
        }
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
    ethereumPath = Path.join(root, "wire-ethereum")
    solanaPath = Path.join(root, "wire-solana")
    externalBindFile = Path.join(root, "external-bind.json")
    seedLocalCluster()
    seedOutpostArtifacts()
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
        .filter(node => NodeConfig.isOperatorRole(node.role))
        .map(node => node.batchOperatorLabel ?? node.underwriterLabel)
    expect(emitted.accounts.operators.map(op => op.accountName).sort()).toEqual(
      [...expectedAccounts].sort()
    )
    expect(persisted.map(operator => operator.label).sort()).toEqual(
      [...handles].sort()
    )
    expect(expectedAccounts.sort()).not.toEqual([...handles].sort())

    // The re-rendered config.ini files carry the EXTERNAL bios http port.
    const iniText = findFiles(externalDir, ClusterFiles.NodeConfigFilename)
      .map(file => Fs.readFileSync(file, "utf-8"))
      .join("\n")
    expect(iniText.length).toBeGreaterThan(0)
    expect(iniText).toContain(String(externalBind.nodeop.ports.bios.http))
  })

  // SHARED-29: the whole point of the rebind is that a published tree starts
  // its daemons against the EXTERNAL host:port. Until the outpost artifacts
  // were seeded above, `emitStartScripts` warn-skipped and this suite asserted
  // NOTHING about any start.sh.
  it("rebinds the operator daemon's outpost + debugging endpoints onto the EXTERNAL bind", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    await External.runEmit(ctx, null, signal)
    await External.runVerify(ctx, null, signal)

    const merged = ctx.outputs.assert(External.MergedConfigKey),
      node = assertBatchOperatorNode(merged),
      scriptFile = DaemonConfig.startScriptFile(node.nodePath),
      argv = startScriptArgv(scriptFile),
      account = assertOperatorAccount(merged, node.batchOperatorLabel),
      ethereumClientConfigurationFile = Path.join(
        merged.dataPath,
        OperatorDaemonTool.EthereumClientConfigurationFilename
      ),
      ethereumClientConfiguration = JSON.parse(
        Fs.readFileSync(ethereumClientConfigurationFile, "utf-8")
      ),
      // FULL `address:port` URLs on both sides. `shiftPorts` moves PORTS only,
      // so the local and external ADDRESSES are byte-identical — an
      // address-only assertion passes against a completely un-rebound script.
      externalEthereumRpcUrl = toURL(
        externalBind.anvil.port,
        toDialAddress(externalBind.anvil.address)
      ),
      externalSolanaRpcUrl = toURL(
        externalBind.solana.ports.http,
        toDialAddress(externalBind.solana.address)
      ),
      externalDebuggingServerUrl = toURL(
        externalBind.debuggingServer.port,
        toDialAddress(externalBind.debuggingServer.address)
      ),
      localEthereumRpcUrl = toURL(
        PersistedFixture.bind.anvil.port,
        toDialAddress(PersistedFixture.bind.anvil.address)
      ),
      localSolanaRpcUrl = toURL(
        PersistedFixture.bind.solana.ports.http,
        toDialAddress(PersistedFixture.bind.solana.address)
      ),
      localDebuggingServerUrl = toURL(
        PersistedFixture.bind.debuggingServer.port,
        toDialAddress(PersistedFixture.bind.debuggingServer.address)
      )

    expect(argv.length).toBeGreaterThan(0)
    expect(argvValuesOf(argv, "--outpost-ethereum-client")).toEqual([])
    expect(argvValuesOf(argv, "--outpost-ethereum-client-config-file")).toEqual([
      toRelocatableToken(ethereumClientConfigurationFile, [
        {
          prefix: merged.clusterPath,
          variable: StartScriptVariable.CLUSTER_DIR
        }
      ])
    ])
    expect(ethereumClientConfiguration.clients[0].connection.rpc_url).toBe(
      externalEthereumRpcUrl
    )
    expect(ethereumClientConfiguration.clients[0].chain_id).toBe(
      AnvilProcess.DefaultChainId
    )
    expect(ethereumClientConfiguration.clients[0].transaction_policy).toEqual(
      AnvilEthereumTransactionPolicyConfig.create()
    )
    expect(argvValuesOf(argv, "--outpost-solana-client")).toEqual([
      [
        OperatorDaemonTool.SolanaClientId,
        `sol-${account}`,
        externalSolanaRpcUrl
      ].join(",")
    ])
    expect(argvValuesOf(argv, "--ext-debugging-server")).toEqual([
      externalDebuggingServerUrl
    ])
    // Target the SPECIFIC option specs, never a blanket scan of the file: a
    // `--signature-provider` value legitimately contains `ethereum` / `solana`.
    const [solanaSpec] = argvValuesOf(argv, "--outpost-solana-client")
    expect(ethereumClientConfiguration.clients[0].connection.rpc_url).not.toContain(
      localEthereumRpcUrl
    )
    expect(solanaSpec).not.toContain(localSolanaRpcUrl)
    expect(argvValuesOf(argv, "--ext-debugging-server")).not.toContain(
      localDebuggingServerUrl
    )
  })

  // SHARED-28: the map mode is CLI-only (no ini kv), so a rebound start.sh is
  // the surface a published tree actually relaunches through — every nodeop
  // node's script must carry it, not just the batch operator's.
  it("carries --database-map-mode mapped_private in EVERY rebound nodeop start.sh", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)

    const nodes = NodeConfig.plan(ctx.outputs.assert(External.MergedConfigKey))
    expect(nodes.length).toBeGreaterThan(0)
    nodes.forEach(node =>
      expect(
        argvValuesOf(
          startScriptArgv(DaemonConfig.startScriptFile(node.nodePath)),
          "--database-map-mode"
        )
      ).toEqual([DatabaseMapMode.mapped_private])
    )
  })

  // SHARED-31: the chain-state DB size is CLI-only (no ini kv) and UNIFORM, so
  // a rebound start.sh — the surface a published tree relaunches through — must
  // carry it on every nodeop node, not just the operators'.
  it("carries --chain-state-db-size-mb 1024 in EVERY rebound nodeop start.sh", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)

    const nodes = NodeConfig.plan(ctx.outputs.assert(External.MergedConfigKey))
    expect(nodes.length).toBeGreaterThan(0)
    nodes.forEach(node =>
      expect(
        argvValuesOf(
          startScriptArgv(DaemonConfig.startScriptFile(node.nodePath)),
          ChainStateDbSizeFlag
        )
      ).toEqual([String(DefaultChainStateDbSizeMb)])
    )
  })

  // SHARED-25 AC#2 + AC#3, end to end: an emitted start.sh IS the
  // post-bootstrap launch form, so a REBOUND tree must relaunch under the
  // deadline rules — and its ini must not smuggle back what the argv omits.
  it("applies the post-bootstrap deadline rules to every rebound nodeop start.sh", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)

    const merged = ctx.outputs.assert(External.MergedConfigKey),
      nodes = NodeConfig.plan(merged),
      argvFor = (node: NodeConfig) =>
        startScriptArgv(DaemonConfig.startScriptFile(node.nodePath))
    expect(nodes.length).toBeGreaterThan(0)

    // AC#2 is role-blind — nodeop's stock transaction deadline applies to all.
    nodes.forEach(node =>
      expect(argvFor(node)).not.toContain(MaxTransactionTimeFlag)
    )

    // AC#3: the public-API-serving roles lose both timeout flags…
    const producer = nodes.find(node => node.role === NodeRole.producer)
    expect(producer).toBeDefined()
    expect(argvFor(producer)).not.toContain(AbiSerializerMaxTimeFlag)
    expect(argvFor(producer)).not.toContain(HttpMaxResponseTimeFlag)

    // …while an operator node keeps them (AC#3's non-public exception).
    const batchArgv = argvFor(assertBatchOperatorNode(merged))
    expect(argvValuesOf(batchArgv, AbiSerializerMaxTimeFlag)).toEqual([
      String(NodeopProcess.OperatorAbiSerializerMaxTimeMs)
    ])
    expect(argvValuesOf(batchArgv, HttpMaxResponseTimeFlag)).toEqual([
      String(NodeopProcess.OperatorHttpMaxResponseTimeMs)
    ])

    // The ini is read through `--config-dir` by the very same launch, so a
    // surviving kv there would override the omission the argv just made.
    const iniText = findFiles(externalDir, ClusterFiles.NodeConfigFilename)
      .map(file => Fs.readFileSync(file, "utf-8"))
      .join("\n")
    expect(iniText.length).toBeGreaterThan(0)
    expect(iniText).not.toContain(IniMaxTransactionTimeKey)
  })

  // SHARED-25 AC#4 (the author's D3 carve-out): the REBOUND tree is the
  // production-shaped one, so its bios / producer nodes drop trace_api while
  // its non-public operator nodes keep it. Asserted on the emitted artifacts —
  // the surface a published tree actually relaunches through.
  it("drops trace_api from the rebound producer/bios script + ini, keeping it on operators", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)

    const merged = ctx.outputs.assert(External.MergedConfigKey),
      argvFor = (node: NodeConfig) =>
        startScriptArgv(DaemonConfig.startScriptFile(node.nodePath)),
      // The WHOLE script, not just its argv lines: the probe lives in the
      // CONDITIONAL_ARGS block, which `startScriptArgv` filters out by design —
      // asserting the flag's absence on the argv alone is unfalsifiable.
      scriptFor = (node: NodeConfig) =>
        Fs.readFileSync(DaemonConfig.startScriptFile(node.nodePath), "utf-8"),
      iniFor = (node: NodeConfig) =>
        Fs.readFileSync(
          Path.join(node.nodePath, ClusterFiles.NodeConfigFilename),
          "utf-8"
        )

    // The Rebind's stamp IS the gate's input — assert it before its effects.
    expect(merged.deploymentKind).toBe(ClusterDeploymentKind.external)

    const publicNodes = NodeConfig.plan(merged).filter(
      node => !NodeConfig.isOperatorRole(node.role)
    )
    expect(publicNodes.length).toBeGreaterThan(0)
    publicNodes.forEach(node => {
      expect(argvFor(node)).not.toContain(Constants.TRACE_API_PLUGIN)
      // The probe moves with the plugin: nodeop rejects the flag outright when
      // trace_api_plugin is not loaded. Asserted on the SCRIPT TEXT, since the
      // probe renders inside the CONDITIONAL_ARGS block rather than the argv…
      expect(scriptFor(node)).not.toContain(NodeopProcess.TraceNoAbisFlag)
      // …and the block itself is still emitted, empty — the `exec` line always
      // expands the array, so its declaration is not optional.
      expect(scriptFor(node)).toContain(
        `${StartScriptRenderer.ConditionalArrayName}=()`
      )
      // The ini is read through `--config-dir` by the very same launch, so a
      // surviving plugin line there would re-load what the argv just dropped.
      expect(iniFor(node)).not.toContain(Constants.TRACE_API_PLUGIN)
    })

    const operator = assertBatchOperatorNode(merged)
    expect(argvFor(operator)).toContain(Constants.TRACE_API_PLUGIN)
    // The POSITIVE control the negatives above need: an operator node keeps the
    // plugin, so its script DOES carry the probe — proving the assertions are
    // falsifiable rather than passing because nothing ever renders the flag.
    expect(scriptFor(operator)).toContain(NodeopProcess.TraceNoAbisFlag)
    expect(scriptFor(operator)).toContain(
      `${StartScriptRenderer.ConditionalArrayName}+=('${NodeopProcess.TraceNoAbisFlag}')`
    )
    // …and an operator ini never carried the line in EITHER kind (operators
    // take BASE_PLUGINS only; their daemon args carry the rest).
    expect(iniFor(operator)).not.toContain(Constants.TRACE_API_PLUGIN)
  })

  it("persists deploymentKind:external in the rebound cluster-config.json", async () => {
    const ctx = runContext()
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)

    const merged = ctx.outputs.assert(External.MergedConfigKey),
      reloaded = ClusterConfigProvider.loadSync(
        ClusterConfigProvider.configFilePath(merged)
      )
    // Every later `run` of the published tree re-reads this file, so the stamp
    // has to survive the write rather than live only in the merged model.
    expect(reloaded.deploymentKind).toBe(ClusterDeploymentKind.external)
    // …while the LOCAL source cluster it was cloned from stays local.
    expect(ctx.config.deploymentKind).toBe(ClusterDeploymentKind.local)
  })

  // D6: an already-deployed outpost's endpoint cannot be described by any bind
  // config, so `externalOutposts.<chain>.rpcUrl` OUTRANKS the bind — and the
  // rebind must carry that authority into the daemon scripts it re-renders.
  it("keeps an external-outpost rpcUrl authoritative over the external bind in the rebound scripts", async () => {
    const ctx = runContext(
      externalBindFile,
      PersistedFixture.signatureProvider,
      undefined,
      seedExternalOutposts()
    )
    await External.runLoadExternalBind(ctx, null, signal)
    await External.runClone(ctx, null, signal)
    await External.runRebind(ctx, null, signal)
    await External.runEmit(ctx, null, signal)
    await External.runVerify(ctx, null, signal)

    const merged = ctx.outputs.assert(External.MergedConfigKey),
      node = assertBatchOperatorNode(merged),
      scriptFile = DaemonConfig.startScriptFile(node.nodePath),
      argv = startScriptArgv(scriptFile),
      account = assertOperatorAccount(merged, node.batchOperatorLabel),
      ethereumClientConfigurationFile = Path.join(
        merged.dataPath,
        OperatorDaemonTool.EthereumClientConfigurationFilename
      ),
      ethereumClientConfiguration = JSON.parse(
        Fs.readFileSync(ethereumClientConfigurationFile, "utf-8")
      )

    // The Rebind carries the non-file fields through UNTOUCHED while moving
    // every FILE ref in-tree — a re-stated field list dropped `rpcUrl` here and
    // the daemons silently fell back to the bind.
    expect(merged.externalOutposts.ethereum.rpcUrl).toBe(ExternalEthereumRpcUrl)
    expect(merged.externalOutposts.solana.rpcUrl).toBe(ExternalSolanaRpcUrl)
    expect(merged.externalOutposts.ethereum.chainId).toBe(ExternalChainId)
    expect(merged.externalOutposts.ethereum.addressFile.startsWith(externalDir)).toBe(true)
    expect(merged.externalOutposts.solana.idlFile.startsWith(externalDir)).toBe(true)

    // The generated ETH client file keeps the AUTHORITATIVE endpoint and real
    // chain id; the argv references that stable artifact.
    expect(argvValuesOf(argv, "--outpost-ethereum-client")).toEqual([])
    expect(argvValuesOf(argv, "--outpost-ethereum-client-config-file")).toEqual([
      toRelocatableToken(ethereumClientConfigurationFile, [
        {
          prefix: merged.clusterPath,
          variable: StartScriptVariable.CLUSTER_DIR
        }
      ])
    ])
    expect(ethereumClientConfiguration.clients[0].connection.rpc_url).toBe(
      ExternalEthereumRpcUrl
    )
    expect(ethereumClientConfiguration.clients[0].chain_id).toBe(
      ExternalChainId
    )
    expect(ethereumClientConfiguration.clients[0].transaction_policy).toBeUndefined()
    expect(argvValuesOf(argv, "--outpost-solana-client")).toEqual([
      [
        OperatorDaemonTool.SolanaClientId,
        `sol-${account}`,
        ExternalSolanaRpcUrl
      ].join(",")
    ])
    // The EXTERNAL BIND's own outpost URLs are nowhere in the script…
    const script = Fs.readFileSync(scriptFile, "utf-8")
    expect(script).not.toContain(
      toURL(externalBind.anvil.port, toDialAddress(externalBind.anvil.address))
    )
    expect(script).not.toContain(
      toURL(
        externalBind.solana.ports.http,
        toDialAddress(externalBind.solana.address)
      )
    )
    // …while the debugging sink, which has no outpost override, still follows it.
    expect(argvValuesOf(argv, "--ext-debugging-server")).toEqual([
      toURL(
        externalBind.debuggingServer.port,
        toDialAddress(externalBind.debuggingServer.address)
      )
    ])
    // And the emitted self-description keeps the authoritative endpoints.
    const emitted = ExternalClusterConfigSchemaCodec.deserialize(
      Fs.readFileSync(externalConfigFile(), "utf-8")
    )
    expect(emitted.ethereum.rpcUrl).toBe(ExternalEthereumRpcUrl)
    expect(emitted.ethereum.chainId).toBe(ExternalChainId)
    expect(emitted.solana.rpcUrl).toBe(ExternalSolanaRpcUrl)
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

  // SHARED-31: `--chain-state-db-size-mb <N>` now rides EVERY emitted start.sh
  // (and the rebound cluster-config.json). `N` is an operator-chosen MEGABYTE
  // count that can legitimately land inside the Linux ephemeral port range —
  // SHARED-30's own sketch uses 32768 — so it collides with the very numbers
  // this scan hunts for.
  describe("Verify — the chain-state DB size is a megabyte count, not a port", () => {
    /** A LOCAL bind port absent from the shifted external bind ⇒ stale. */
    const staleLocalPort = PersistedFixture.bind.nodeop.ports.bios.http

    /**
     * Load → clone → rebind → emit with the DB size deliberately EQUAL to that
     * stale port; hands back the context and one emitted script to inspect.
     */
    async function emitWithCollidingDbSize() {
      const ctx = runContext(
        externalBindFile,
        PersistedFixture.signatureProvider,
        undefined,
        null,
        { chainStateDbSizeMb: staleLocalPort }
      )
      await External.runLoadExternalBind(ctx, null, signal)
      await External.runClone(ctx, null, signal)
      await External.runRebind(ctx, null, signal)
      await External.runEmit(ctx, null, signal)
      const merged = ctx.outputs.assert(External.MergedConfigKey)
      return {
        ctx,
        configFile: ClusterConfigProvider.configFilePath(merged),
        scriptFile: DaemonConfig.startScriptFile(
          assertBatchOperatorNode(merged).nodePath
        )
      }
    }

    it("PASSES when a stale local port number occurs only as the DB-size VALUE", async () => {
      const { ctx, configFile, scriptFile } = await emitWithCollidingDbSize()
      // Falsifiability: the number really is in the emitted script, and really
      // is that flag's value — so the scan had something to (wrongly) catch.
      expect(
        argvValuesOf(startScriptArgv(scriptFile), ChainStateDbSizeFlag)
      ).toEqual([String(staleLocalPort)])
      expect(Fs.readFileSync(scriptFile, "utf-8")).toContain(
        String(staleLocalPort)
      )
      // The rebound cluster-config.json carries the SAME number under the
      // persisted field — both carriers of this one value are masked, not just
      // the script (and this file is scanned FIRST, so it fails first).
      expect(Fs.readFileSync(configFile, "utf-8")).toContain(
        String(staleLocalPort)
      )
      await expect(
        External.runVerify(ctx, null, signal)
      ).resolves.toBeUndefined()
    })

    it("still REJECTS that same number occurring ANYWHERE else in the script", async () => {
      const { ctx, scriptFile } = await emitWithCollidingDbSize()
      // The mask is POSITIONAL, not by value: an un-rebound local endpoint
      // carrying the identical digits must still hard-fail the scan.
      Fs.appendFileSync(scriptFile, `\n# leftover endpoint: ${staleLocalPort}\n`)
      await expect(External.runVerify(ctx, null, signal)).rejects.toThrow(
        new RegExp(`still contains the local bind port ${staleLocalPort}`)
      )
    })
  })

  it("emits KEY providers with inline plaintext private keys (unchanged)", async () => {
    const emitted = await emitWithProvider(KeyProvider)
    expect(emitted.accounts.operators.length).toBeGreaterThan(0)
    emitted.accounts.operators.forEach(op =>
      op.keyProviders.forEach(provider =>
        // Compared against the PERSISTED pair for this account+curve rather
        // than a spelled-out placeholder: the operators' EM / ED pairs are real
        // key material (the daemon argv parses them), so only cluster-keys can
        // say what their private keys are.
        expect(provider).toMatchObject({
          providerType: SignatureProviderType.KEY,
          privateKey: persistedKeyPair(op.accountName, provider.type).privateKey
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
