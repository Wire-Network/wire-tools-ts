/**
 * Cluster lifecycle manager for Wire e2e tests.
 *
 * Mirrors the Python `wire-sysio/tools/cluster_manager.py` behavior:
 *   - Generates K1 + BLS keys per node (via clio / sys-util)
 *   - Writes `start.cmd`, `logging.json`, `genesis.json` per node
 *   - Writes default `config.ini` with HTTP insecure settings appended
 *   - Launches nodes by executing the start.cmd args
 *   - Runs the full bootstrap sequence (contract deployment, accounts, tokens)
 *   - Persists state to `cluster-state.json` for relaunch via `run`
 */

import Path from "path"
import Fs from "fs"
import * as Sh from "shelljs"
import {
  type ProcessHandle,
  ProcessManager
} from "../processes/ProcessManager.js"
import { AnvilManager } from "../processes/AnvilManager.js"
import { SolanaValidatorManager } from "../processes/SolanaValidatorManager.js"
import { KiodManager } from "../processes/KiodManager.js"
import { Clio } from "../clients/Clio.js"
import { WIREClient } from "../clients/WIREClient.js"
import {
  deploySysContract,
  createSysioAccount,
  sysioActiveCodeAuthority
} from "./sysContractDeploy.js"
import { log } from "../logger.js"
import { mkdirs, retry, sleep, waitForEndpoint } from "../util.js"
import {
  ListenAllAddress,
  Localhost,
  toAddress,
  toURL
} from "../tools/NetTools.js"
import { generateGenesis } from "./genesis.js"
import {
  BIOS_BLS_KEY,
  BIOS_K1_KEY,
  formatK1SignatureProvider,
  generateNodeKeySet,
  type NodeKeySet
} from "./keyGen.js"
import { buildRelaunchCmd, buildStartCmd } from "./startCmd.js"
import { generateLoggingConfig } from "./generateLoggingConfig"
import {
  BATCH_OPERATOR_PLUGINS,
  UNDERWRITER_PLUGINS,
  batchOperatorAccountName,
  BIOS_HTTP_PORT,
  BOOTSTRAP_NODE_OWNER,
  DEV_K1_PRIVATE_KEY,
  DEV_K1_PUBLIC_KEY,
  EMISSION_CONFIG_DEFAULTS,
  type EmissionConfig,
  MAX_PRODUCERS,
  OPP_CONTRACT_PATHS,
  OPP_SYSTEM_ACCOUNTS,
  SYSTEM_ACCOUNTS,
  underwriterAccountName
} from "./constants.js"
import {
  addResourcePolicy,
  createAccountWithRam,
  createAccountWithResources,
  isAccountAlreadyExistsError
} from "./accountProvisioning.js"
import { ethers } from "ethers"
import * as Assert from "node:assert"
import { Keypair, PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { Bytes, SlugName, KeyType, PrivateKey, SystemContracts } from "@wireio/sdk-core"
import { which } from "zx"
import { asOption } from "@3fv/prelude-ts"
import { range } from "lodash"
import { Deferred, getValue, isNumber, isString } from "@wireio/shared"
import { DebuggingServer } from "@wireio/debugging-server"
import { ETHBootstrapper } from "./ETHBootstrapper.js"
import { SOLBootstrap } from "../bootstrap/SOLBootstrap.js"
import { UnderwriterTools } from "../tools/underwriter/index.js"
import { writeClusterConfigFile } from "./ClusterConfigPersistence.js"
import {
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  freshEthPubEm
} from "../tools/AuthExLinkTool.js"
import {
  NodeOwnerTier,
  pushNewNamedUser,
  pushNodeOwnerReg,
  readNodeOwner,
  readNodeOwnerReg
} from "../tools/NodeOwnerNFTTool.js"
import { ClusterPorts } from "./ClusterPorts.js"
import Bluebird from "bluebird"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterFiles,
  NodeRole,
  type ClusterConfig,
  type ClusterExePaths,
  type ClusterState,
  type NodeState,
  type SolanaProgramDeployment
} from "@wireio/debugging-shared"

import { ClusterOptions } from "../HarnessTypes"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Cluster shapes now live in `@wireio/debugging-shared/cluster/Types`
// so out-of-process tooling (TUI, debugging server) can consume them without
// pulling in the full harness runtime. Re-exported here for backward compat
// with existing consumers (flow-*, TestEnvironment, FlowTestContext).
export type {
  ClusterConfig,
  ClusterExePaths,
  ClusterState,
  ClusterFiles,
  NodeState,
  OperatorNodeKeyMaterial,
  SolanaProgramDeployment
} from "@wireio/debugging-shared"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Generate `count` node key sets and import each K1 + BLS private key into the wallet.
 */
async function generateAndImportKeys(
  executables: ClusterExePaths,
  clio: Clio,
  count: number
): Promise<NodeKeySet[]> {
  const keys: NodeKeySet[] = []
  await Bluebird.each(range(count), async () => {
    const keySet = await generateNodeKeySet(executables)
    await Bluebird.each([keySet.k1.privateKey, keySet.bls.privateKey], key =>
      clio.walletImportKey("default", key)
    )
    keys.push(keySet)
  })
  return keys
}

/**
 * Grant `account@sysio.code` on the account's owner authority so it can inline-send actions, while
 * keeping the account governed by `sysio@active` (no standalone key) — the production model. The account
 * was created with owner = active = sysio@active; this resets owner to sysio@active + account@sysio.code.
 * Used by OPP contracts that need inline action capabilities.
 */
async function grantSysioCode(clio: Clio, account: string): Promise<void> {
  await clio.pushTransactionAndWait({
    account: "sysio",
    name: "updateauth",
    data: {
      account,
      permission: "owner",
      parent: "",
      auth: sysioActiveCodeAuthority([account])
    },
    authorization: [{ actor: account, permission: "owner" }]
  })
}

/**
 * Link ETH + SOL chain accounts via authex for an operator.
 * Derives an ETH wallet from the anvil mnemonic at the given HD index.
 *
 * The SOL key MUST match the ED25519 key used by the batch operator node's
 * `--signature-provider sol-<account>,...` — otherwise the OPERATORS
 * attestation carries a different SOL pubkey than the one signing Solana
 * transactions and epoch_in would reject the signer as an inactive operator.
 */
async function linkOperatorChainAccounts(
  clio: Clio,
  anvilMnemonic: ethers.Mnemonic,
  account: string,
  hdIndex: number,
  solPrivateKey?: PrivateKey,
  skipSolLink: boolean = false
): Promise<void> {
  const ethWallet = ethers.HDNodeWallet.fromMnemonic(
    anvilMnemonic,
    `${ETHBootstrapper.DerivationPath}${hdIndex}`
  )

  await createAuthExLink(clio, {
    chainKind: ChainKind.EVM,
    account,
    privateKey: emPrivateKeyFromEthWallet(ethWallet),
    ethWallet
  })

  if (!skipSolLink) {
    await createAuthExLink(clio, {
      chainKind: ChainKind.SVM,
      account,
      privateKey: solPrivateKey ?? PrivateKey.generate(KeyType.ED)
    })
  }
}

/**
 * INI fragment appended to every node's `config.ini` to loosen HTTP
 * restrictions so local tooling and tests can hit the nodeop RPC without
 * preflight or host-header wrangling.
 *
 * Mirrors the Python `cluster_manager._patch_configs_http_insecure`.
 * Removing any of these settings will break the harness and flow tests
 * that hit `http://127.0.0.1:...` endpoints directly.
 */
const HTTP_INSECURE_INI = `
# -- http-insecure settings (cluster_manager) --
# Specify the Access-Control-Allow-Origin to be returned on each request (sysio::http_plugin)
access-control-allow-origin = *
# Specify the Access-Control-Allow-Headers to be returned on each request (sysio::http_plugin)
access-control-allow-headers = *
# Append the error log to HTTP responses (sysio::http_plugin)
verbose-http-errors = true
# If set to false, then any incoming "Host" header is considered valid (sysio::http_plugin)
http-validate-host = false
`

function toProducerName(index: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz"
  return `defproducer${chars[index % chars.length]}`
}

// ---------------------------------------------------------------------------
// ClusterManager
// ---------------------------------------------------------------------------

/** Zero-pad width used when `toNodeLabel` prefixes its input. */
const NodeLabelPadWidth = 2

/**
 * Derive the log / process label for a cluster node.
 *
 * Numeric ids and numeric-string ids are zero-padded to
 * {@link NodeLabelPadWidth} digits; non-numeric ids (e.g. `batchop_00`) are
 * passed through unchanged. The returned string is what `ProcessManager`
 * and `pm2` / log directory structures key on.
 *
 * @param nodeId - Either a numeric producer index or an already-formatted
 *                 operator node id.
 * @returns A `node-XX` / `node-<id>` label suitable for process logs.
 *
 * @example
 * toNodeLabel(3)              // "node-03"
 * toNodeLabel("7")            // "node-07"
 * toNodeLabel("batchop_00")   // "node-batchop_00"
 */
export function toNodeLabel(nodeId: string | number): string {
  const padded =
    isString(nodeId) && /^\d+$/.test(nodeId)
      ? nodeId.padStart(NodeLabelPadWidth, "0")
      : isNumber(nodeId)
        ? nodeId.toString().padStart(NodeLabelPadWidth, "0")
        : nodeId
  return `node-${padded}`
}

export class ClusterManager {
  private readonly onStopDeferred = new Deferred<void>()
  private _state: ClusterState | null = null
  private debuggingServer: DebuggingServer | null = null

  /**
   * Persisted cluster topology + per-node state. Populated by `create()`
   * after bootstrap completes (or by `loadState()` in attach mode).
   * Read-only to outside callers — mutate via the public mutators on
   * this class (`create`, `loadState`, …). Consumers like
   * `FlowTestContext.getWallet` read `state.batchOperatorNodes` /
   * `state.underwriterNodes` to reconstruct operator wallets.
   */
  get state(): ClusterState | null {
    return this._state
  }

  get clusterPath() {
    return this.config.clusterPath
  }

  toDataPath(...paths: string[]): string {
    return Path.join(this.clusterPath, ClusterManager.DataSubpath, ...paths)
  }

  constructor(readonly config: ClusterConfig) {}

  /** In-memory state populated by `create()` when a SOL outpost is configured,
   *  folded into `ClusterState` before persistence. `start()` consumes it to
   *  re-launch the test validator with the same program deployments. */
  private solanaPrograms?: SolanaProgramDeployment[]
  private solanaIdlPath?: string

  /**
   * Phase 10b: build + launch solana-test-validator + deploy opp-outpost + init PDAs.
   * Returns the deployed program id (base58) and the IDL path to forward to
   * batch operator nodes via `--solana-idl-file` / `--batch-sol-program-id`.
   */
  private async bootstrapSolanaOutpost(
    cfg: ClusterConfig,
    dataPath: string,
    batchOpSolKeys: Record<string, PrivateKey>
  ): Promise<{ programId: string; idlPath: string }> {
    log.info("[Phase 10b] Solana outpost bootstrap starting")

    // Resolve build artifacts from the wire-solana source tree. We don't
    // invoke `anchor build` here — this path runs inside an already-prepared
    // devcontainer and the .so / IDL / program keypair must exist on disk.
    const programKeypairFile = Path.join(
      cfg.solanaPath,
      "wallets",
      "opp-outpost-keypair.json"
    )
    const soFile = Path.join(
      cfg.solanaPath,
      "target",
      "deploy",
      "opp_outpost.so"
    )

    if (!Fs.existsSync(soFile)) {
      log.info(
        `File (${soFile}) not found, attempting to build opp-outpost program artifacts...`
      )
      const cargoRes = Sh.exec("cargo build", { cwd: cfg.solanaPath })
      Assert.ok(
        cargoRes.code === 0,
        `Cargo build failed with exit code ${cargoRes.code}: ${cargoRes.stderr}`
      )

      const anchorRes = Sh.exec("anchor build -p opp-outpost", {
        cwd: cfg.solanaPath
      })
      Assert.ok(
        anchorRes.code === 0,
        `Anchor build failed with exit code ${anchorRes.code}: ${anchorRes.stderr}`
      )
    }

    const idlSrc = Path.join(
      cfg.solanaPath,
      "target",
      "idl",
      "opp_outpost.json"
    )
    Assert.ok(
      Fs.existsSync(programKeypairFile),
      `opp-outpost keypair missing: ${programKeypairFile} (run 'anchor build -p opp-outpost')`
    )
    Assert.ok(
      Fs.existsSync(soFile),
      `opp-outpost .so missing: ${soFile} (run 'anchor build -p opp-outpost')`
    )
    Assert.ok(
      Fs.existsSync(idlSrc),
      `opp-outpost IDL missing: ${idlSrc} (run 'anchor build -p opp-outpost')`
    )

    // Read program id from keypair to feed --bpf-program <id> <so>. Use the
    // static `import { Keypair }` at the top of this file rather than a
    // dynamic `await import(...)` — the dynamic form requires jest to run
    // with `--experimental-vm-modules`, which the harness does not enable,
    // so every flow test hit `A dynamic import callback was invoked without
    // --experimental-vm-modules` inside the SOL-bootstrap leg of cluster
    // bring-up.
    const keyBytes = Uint8Array.from(
      JSON.parse(Fs.readFileSync(programKeypairFile, "utf-8"))
    )
    const programId = Keypair.fromSecretKey(keyBytes).publicKey.toBase58()

    // Copy the IDL into the cluster data dir so batch op nodes read a stable
    // path that survives recompilation of wire-solana.
    const idlDir = mkdirs(Path.join(dataPath, "solana-idls"))
    const idlDst = Path.join(idlDir, "opp_outpost.json")
    Fs.copyFileSync(idlSrc, idlDst)

    // Launch the test validator with the program pre-loaded. We also reserve
    // the ledger path under cluster data so `start()` can re-boot the same
    // validator without re-shipping the .so.
    const ledgerPath = Path.join(dataPath, ClusterManager.SolanaLedgerSubpath)
    const solManager = await SolanaValidatorManager.create({
      binary: cfg.executables.solanaTestValidator,
      rpcPort: cfg.ports.solanaRpc,
      faucetPort: cfg.ports.solanaFaucet,
      ledgerPath,
      programs: [{ name: "opp_outpost", programId, soFile }]
    })
    await solManager.start()

    // Initialise on-chain PDAs (OutpostConfig, OutboundMessageBuffer, OperatorRegistry).
    // `clusterDataPath` lets SOLBootstrap persist mock SPL mint
    // pubkeys (USDC/USDT/LIQSOL) for Phase 16a/b/c token-row
    // registration; the file lives under
    // `<cluster>/data/sol-mock-mints.json`.
    const bootstrap = new SOLBootstrap({
      wireSolPath: cfg.solanaPath,
      rpcUrl: toURL(cfg.ports.solanaRpc),
      programKeypairFile,
      clusterDataPath: Path.join(cfg.clusterPath, "data")
    })
    await bootstrap.bootstrap()

    // Airdrop batch operator SOL signing accounts. The ledger persists across
    // restarts, so these balances only need to be seeded once during `create`.
    const batchOpSolPubkeys = Object.values(batchOpSolKeys).map(k =>
      k.toPublic().toNativeString()
    )
    if (batchOpSolPubkeys.length > 0) {
      log.info(
        `Airdropping SOL to ${batchOpSolPubkeys.length} batch operator account(s)...`
      )
      await bootstrap.airdropAccounts(batchOpSolPubkeys)
    }

    this.solanaPrograms = [{ name: "opp_outpost", programId, soFile }]
    this.solanaIdlPath = idlDst
    log.info(
      `[Phase 10b] Solana outpost bootstrap complete (programId=${programId})`
    )
    return { programId, idlPath: idlDst }
  }

  /** Start the in-process OPP debugging server. */
  private async startDebuggingServer(): Promise<void> {
    this.debuggingServer = await DebuggingServer.create({
      port: this.config.ports.debuggingServer,
      clusterPath: this.config.clusterPath
    })
    const addr = await this.debuggingServer.start()
    log.info(`Debugging server listening on ${addr.address}:${addr.port}`)
  }

  /** Stop the in-process OPP debugging server if running. */
  private async stopDebuggingServer(): Promise<void> {
    if (this.debuggingServer) {
      await this.debuggingServer.stop()
      this.debuggingServer = null
      log.info("Debugging server stopped")
    }
  }

  /**
   * Create a new cluster: generate keys, write start.cmd / logging.json /
   * genesis.json per node, start all nodes, run the full bootstrap sequence,
   * then shut everything down and persist state for later `start()`.
   */
  async create(): Promise<ClusterManager> {
    try {
      const cfg = { ...this.config },
        { clusterPath, buildPath, dataPath, walletPath, executables } = cfg,
        launchTime = new Date().toISOString().replace("Z", "").slice(0, 23)

      log.info(
        `Creating cluster in ${clusterPath} (producers=${cfg.producerCount}, nodes=${cfg.nodeCount}, ` +
          `batchOps=${cfg.batchOperatorCount}, underwriters=${cfg.underwriterCount})`
      )

      // ── 1. Directory structure ──
      Array<string>(
        ClusterManager.AnvilStateSubpath,
        ClusterManager.SolanaLedgerSubpath,
        ClusterManager.BiosNodePath,
        ...range(cfg.nodeCount).map(i => ClusterManager.toProducerNodePath(i)),
        ...range(cfg.batchOperatorCount).map(i =>
          ClusterManager.toBatchOpNodePath(i)
        ),
        ...range(cfg.underwriterCount).map(i =>
          ClusterManager.toUnderwriterNodePath(i)
        )
      )
        .map(childPath => this.toDataPath(childPath))
        .forEach(mkdirs)

      mkdirs(walletPath)

      // Start debugging server first so that its URL can be passed into node start.cmd args
      await this.startDebuggingServer()

      // ── 2. Start kiod + create wallet FIRST (keys go in as they're generated) ──

      const kiod = await KiodManager.create({
        binary: executables.kiod,
        walletPath: walletPath,
        port: cfg.ports.kiod
      })
      await kiod.start()

      const clioWallet = new Clio({
        clusterPath,
        binary: executables.clio,
        url: ClusterManager.ClioFallbackUrl,
        walletUrl: kiod.httpUrl
      })
      await clioWallet.walletCreate("default")

      // Import bios keys immediately
      await Bluebird.each(
        [BIOS_K1_KEY.privateKey, BIOS_BLS_KEY.privateKey],
        key => clioWallet.walletImportKey("default", key)
      )
      log.info("kiod ready, wallet created, bios keys imported")

      // ── 3. Generate keys (each imported into wallet immediately) ──
      log.info("Generating node keys (K1 + BLS)...")
      const nodeKeys = await generateAndImportKeys(
        executables,
        clioWallet,
        cfg.nodeCount
      )
      const batchOpKeys = await generateAndImportKeys(
        executables,
        clioWallet,
        cfg.batchOperatorCount
      )
      const uwKeys = await generateAndImportKeys(
        executables,
        clioWallet,
        cfg.underwriterCount
      )

      log.info(
        `Generated and imported keys for ${cfg.nodeCount} producer(s), ${cfg.batchOperatorCount} batch op(s), ${cfg.underwriterCount} underwriter(s)`
      )

      // ── 3a. Pre-generate batch operator ED25519 SOL keys ──
      // These must be generated before bootstrapChain so Phase 19a can link
      // them via authex, AND before Phase 10a so the node's signature
      // provider uses the same key. Keyed by operator account name to keep
      // the two sites in sync.
      const batchOpSolKeys: Record<string, PrivateKey> = {}
      range(cfg.batchOperatorCount).forEach(i => {
        const account = batchOperatorAccountName(i)
        batchOpSolKeys[account] = PrivateKey.generate(KeyType.ED)
      })

      // ── 3b. Pre-generate underwriter ED25519 SOL keys ──
      // Same rationale as 3a: keep authex linking + the Phase 19b
      // collateral deposit aligned on a single SOL keypair per
      // underwriter. The harness retains these in-memory only — they
      // exist solely to fund the underwriter's deposit tx + match the
      // pubkey the depot's authex link advertises.
      const uwSolKeys: Record<string, PrivateKey> = {}
      range(cfg.underwriterCount).forEach(i => {
        const account = underwriterAccountName(i)
        uwSolKeys[account] = PrivateKey.generate(KeyType.ED)
      })

      // ── 3. Build producer name assignments (mirrors Python bind_nodes) ──
      const allProducerNames = range(cfg.producerCount).map(toProducerName)
      // Assign producers round-robin across nodes (non-consecutive, matching Python)
      const nodeProducers: string[][] = Array.from(
        { length: cfg.nodeCount },
        () => []
      )
      allProducerNames.forEach((name, i) =>
        nodeProducers[i % cfg.nodeCount].push(name)
      )
      // ── 4. Peer addresses ──
      // allPeerAddresses includes bios (for bios + producer nodes during bootstrap).
      // producerPeerAddresses excludes bios (for batch op + underwriter nodes
      // that start after bios is killed).
      const { ports } = cfg,
        biosP2P = toAddress(ports.biosP2p),
        producerPeerAddresses: string[] = [],
        allPeerAddresses: string[] = [biosP2P]
      ports.producerP2p.forEach(p2p => {
        const addr = toAddress(p2p)
        allPeerAddresses.push(addr)
        producerPeerAddresses.push(addr)
      })
      // ── 5. Write per-node files (genesis, logging, start.cmd, config.ini) ──
      // Helper: write node files
      // ── 5a. Bios node ──
      const genesis = generateGenesis({
          initialFinalizerKey: BIOS_BLS_KEY.publicKey
        }),
        writeNodeFiles = (nodePath: string, cmd: string[]) => {
          const genesisFile = Path.join(nodePath, "genesis.json")

          Fs.writeFileSync(genesisFile, JSON.stringify(genesis, null, 2))
          Fs.writeFileSync(
            Path.join(nodePath, "logging.json"),
            JSON.stringify(generateLoggingConfig(nodePath), null, 2)
          )
          Fs.writeFileSync(Path.join(nodePath, "start.cmd"), cmd.join(" "))
          // Write default config.ini with HTTP insecure patch (matches Python _patch_configs_http_insecure)
          const defaultIniFile = Path.join(
            buildPath,
            "etc",
            "sysio",
            ClusterManager.BiosNodePath,
            "config.ini"
          )
          let configIni = ""
          if (Fs.existsSync(defaultIniFile)) {
            configIni = Fs.readFileSync(defaultIniFile, "utf-8")
          }
          configIni += HTTP_INSECURE_INI
          Fs.writeFileSync(Path.join(nodePath, "config.ini"), configIni)
        },
        biosPath = Path.join(dataPath, ClusterManager.BiosNodePath),
        biosGenesisFile = Path.join(biosPath, "genesis.json"),
        biosCmd = buildStartCmd({
          nodeopBinary: executables.nodeop,
          p2pListenEndpoint: toAddress(ports.biosP2p, ListenAllAddress),
          p2pServerAddress: toAddress(ports.biosP2p),
          p2pPeerAddresses: [],
          httpServerAddress: toAddress(ports.biosHttp),
          enableStaleProduction: true,
          producerNames: ["sysio"],
          k1Keys: [BIOS_K1_KEY],
          blsKeys: [BIOS_BLS_KEY],
          configPath: biosPath,
          dataPath: biosPath,
          genesisJson: biosGenesisFile,
          genesisTimestamp: launchTime,
          p2pMaxNodesPerHost:
            cfg.nodeCount + cfg.batchOperatorCount + cfg.underwriterCount + 1
        })
      writeNodeFiles(biosPath, biosCmd)

      const p2pMaxNodesPerHost =
        cfg.nodeCount + cfg.batchOperatorCount + cfg.underwriterCount + 1

      // ── 5b. Producer nodes ──
      const nodeStates: NodeState[] = range(cfg.nodeCount).map(i => {
        const nodePath = Path.join(
          dataPath,
          ClusterManager.toProducerNodePath(i)
        )
        const nodeGenesisFile = Path.join(nodePath, "genesis.json")
        const httpPort = ports.producerHttp[i]
        const p2pPort = ports.producerP2p[i]
        const peers = allPeerAddresses.filter(a => a !== toAddress(p2pPort))
        const keys = nodeKeys[i]
        const cmd = buildStartCmd({
          nodeopBinary: executables.nodeop,
          p2pListenEndpoint: toAddress(p2pPort, ListenAllAddress),
          p2pServerAddress: toAddress(p2pPort),
          p2pPeerAddresses: peers,
          httpServerAddress: toAddress(httpPort),
          producerNames: nodeProducers[i],
          k1Keys: [keys.k1],
          blsKeys: [keys.bls],
          configPath: nodePath,
          dataPath: nodePath,
          genesisJson: nodeGenesisFile,
          genesisTimestamp: launchTime,
          p2pMaxNodesPerHost
        })
        writeNodeFiles(nodePath, cmd)

        return {
          nodeId: i,
          host: Localhost,
          port: httpPort,
          dataPath: nodePath,
          configPath: nodePath,
          cmd,
          isProducer: nodeProducers[i].length > 0,
          producerName: nodeProducers[i][0] ?? null
        }
      })

      // ── 5c. Batch operator nodes (read-mode=irreversible, no producer_plugin) ──
      // Plugin args for batch_operator_plugin, outpost_ethereum_client_plugin,
      // outpost_solana_client_plugin, cron_plugin are appended here as base args.
      // ETH/SOL-specific args (contract addresses, signing keys) are injected
      // after step 10 (ETH bootstrap) once deployed addresses are known.
      // Base batch operator extra args (plugins + batch-operator config).
      // The WIRE K1 signature provider uses the dev key matching the
      // account's active permission (set during bootstrap account creation).
      const batchOpStates: NodeState[] = range(cfg.batchOperatorCount).map(
        i => {
          const nodePath = Path.join(
            dataPath,
            ClusterManager.toBatchOpNodePath(i)
          )
          const nodeGenesisFile = Path.join(nodePath, "genesis.json")
          const httpPort = ports.batchOperatorHttp[i]
          const p2pPort = ports.batchOperatorP2p[i]
          const peers = producerPeerAddresses.filter(
            a => a !== toAddress(p2pPort)
          )
          const keys = batchOpKeys[i]
          const account = batchOperatorAccountName(i)
          const wireK1SigProvider = formatK1SignatureProvider({
            publicKey: DEV_K1_PUBLIC_KEY,
            privateKey: DEV_K1_PRIVATE_KEY
          })
          const debuggingServerUrl = toURL(ports.debuggingServer)
          const batchOpExtraArgs: string[] = [
            "--read-mode",
            Clio.FinalityType.irreversible,
            ...BATCH_OPERATOR_PLUGINS.flatMap(p => ["--plugin", p]),
            "--signature-provider",
            wireK1SigProvider,
            "--batch-enabled",
            "true",
            "--batch-operator-account",
            account,
            "--batch-epoch-poll-ms",
            String(ClusterManager.BatchEpochPollMs),
            "--batch-delivery-timeout-ms",
            String(ClusterManager.BatchDeliveryTimeoutMs),
            "--ext-debugging-server",
            debuggingServerUrl
          ]
          const cmd = buildStartCmd({
            nodeopBinary: executables.nodeop,
            p2pListenEndpoint: toAddress(p2pPort, ListenAllAddress),
            p2pServerAddress: toAddress(p2pPort),
            p2pPeerAddresses: peers,
            httpServerAddress: toAddress(httpPort),
            producerNames: [], // no producer plugin
            k1Keys: [keys.k1],
            blsKeys: [keys.bls],
            configPath: nodePath,
            dataPath: nodePath,
            genesisJson: nodeGenesisFile,
            genesisTimestamp: launchTime,
            p2pMaxNodesPerHost,
            extraArgs: batchOpExtraArgs
          })

          writeNodeFiles(nodePath, cmd)

          return {
            nodeId: `batchop_${ClusterManager.padIndex(i)}`,
            host: Localhost,
            port: httpPort,
            dataPath: nodePath,
            configPath: nodePath,
            cmd,
            isProducer: false,
            producerName: null,
            role: NodeRole.BatchOperator,
            operatorAccount: account
          }
        }
      )

      // ── 5d. Underwriter nodes (read-mode=irreversible, no producer_plugin) ──
      const underwriterStates: NodeState[] = range(cfg.underwriterCount).map(
        i => {
          const nodePath = Path.join(
            dataPath,
            ClusterManager.toUnderwriterNodePath(i)
          )
          const nodeGenesisFile = Path.join(nodePath, "genesis.json")
          const httpPort = ports.underwriterHttp[i]
          const p2pPort = ports.underwriterP2p[i]
          const peers = producerPeerAddresses.filter(
            a => a !== toAddress(p2pPort)
          )
          const keys = uwKeys[i]
          const account = underwriterAccountName(i)
          const wireK1SigProvider = formatK1SignatureProvider({
            publicKey: DEV_K1_PUBLIC_KEY,
            privateKey: DEV_K1_PRIVATE_KEY
          })
          const debuggingServerUrl = toURL(ports.debuggingServer)
          // Base underwriter args — ETH/SOL outpost client + signing-key
          // injection happens in Phase 10a (after deploy) alongside the
          // batch op outpost injection. The base args here load the
          // underwriter_plugin + outpost client plugins + cron_plugin
          // so the daemon can poll for new UWREQ rows and call
          // OperatorRegistry.commit / opp_outpost::commit_underwrite on
          // the matching outposts.
          const underwriterExtraArgs: string[] = [
            "--read-mode",
            Clio.FinalityType.irreversible,
            ...UNDERWRITER_PLUGINS.flatMap(p => ["--plugin", p]),
            "--plugin",
            "sysio::external_debugging_plugin",
            "--plugin",
            "sysio::cron_plugin",
            "--signature-provider",
            wireK1SigProvider,
            "--underwriter-enabled",
            "true",
            "--underwriter-account",
            account,
            "--ext-debugging-server",
            debuggingServerUrl
          ]
          const cmd = buildStartCmd({
            nodeopBinary: executables.nodeop,
            p2pListenEndpoint: toAddress(p2pPort, ListenAllAddress),
            p2pServerAddress: toAddress(p2pPort),
            p2pPeerAddresses: peers,
            httpServerAddress: toAddress(httpPort),
            producerNames: [], // no producer plugin
            k1Keys: [keys.k1],
            blsKeys: [keys.bls],
            configPath: nodePath,
            dataPath: nodePath,
            genesisJson: nodeGenesisFile,
            genesisTimestamp: launchTime,
            p2pMaxNodesPerHost,
            extraArgs: underwriterExtraArgs
          })
          writeNodeFiles(nodePath, cmd)

          return {
            nodeId: `uwrit_${ClusterManager.padIndex(i)}`,
            host: Localhost,
            port: httpPort,
            dataPath: nodePath,
            configPath: nodePath,
            cmd,
            isProducer: false,
            producerName: null,
            role: NodeRole.Underwriter,
            operatorAccount: account
          }
        }
      )

      log.info(
        `Generated files for bios + ${cfg.nodeCount} producer(s) + ${cfg.batchOperatorCount} batch op(s) + ${cfg.underwriterCount} underwriter(s)`
      )

      // ── 6. Start bios node ──
      await this.launchFromCmd("node-bios", biosCmd, biosPath)
      const biosHttpUrl = toURL(ports.biosHttp)
      await waitForEndpoint(`${biosHttpUrl}/v1/chain/get_info`, {
        label: "bios-node",
        timeoutMs: ClusterManager.NodeStartupTimeoutMs
      })
      log.info("Bios node is ready")

      // ── 8. Start producer nodes ──
      await Promise.all(
        nodeStates.map(ns =>
          this.launchFromCmd(toNodeLabel(ns.nodeId), ns.cmd, ns.dataPath)
        )
      )

      await sleep(ClusterManager.NodeStartDelayMs)

      // Wait for all to sync to block 1
      await Promise.all(
        nodeStates.map(ns =>
          waitForEndpoint(`${toURL(ns.port)}/v1/chain/get_info`, {
            label: toNodeLabel(ns.nodeId),
            timeoutMs: ClusterManager.NodeStartupTimeoutMs
          })
        )
      )
      log.info(`All ${cfg.nodeCount} producer node(s) are ready`)

      // ── 9. Bootstrap ──
      const clio = new Clio({
        clusterPath,
        binary: executables.clio,
        url: biosHttpUrl,
        walletUrl: kiod.httpUrl
      })

      await bootstrapChain(
        clio,
        cfg,
        biosHttpUrl,
        nodeStates,
        nodeKeys,
        batchOpStates,
        underwriterStates,
        batchOpSolKeys,
        uwSolKeys
      )

      // ── 10. ETH bootstrap (if ethereum-dir provided) ──
      const ethBootstrapper = new ETHBootstrapper({
        ethereumPath: cfg.ethereumPath,
        anvilDataPath: Path.join(dataPath, "anvil"),
        anvilPort: cfg.ports.anvil,
        chainId: AnvilManager.DefaultChainId
      })
      await ethBootstrapper.bootstrap()

      // ── 10a. Inject ETH + SOL outpost client args into batch operator cmds ──
      // Now that ETH contracts are deployed, read addresses and configure
      // the outpost client plugins with signing keys and contract addresses.
      const outpostAddrsPath = Path.join(
        cfg.ethereumPath,
        ".local",
        "deployments",
        "outpost-addrs.json"
      )
      Assert.ok(
        Fs.existsSync(outpostAddrsPath),
        `ETH outpost addresses not found at ${outpostAddrsPath}`
      )
      const ethAddrs: Record<string, string> = JSON.parse(
        Fs.readFileSync(outpostAddrsPath, "utf-8")
      )
      const ethOppAddr = ethAddrs.OPP
      const ethOppInboundAddr = ethAddrs.OPPInbound
      Assert.ok(ethOppAddr, "OPP address missing from outpost-addrs.json")
      Assert.ok(
        ethOppInboundAddr,
        "OPPInbound address missing from outpost-addrs.json"
      )

      // ABI files for OPP contracts (Hardhat artifact format, parser handles it)
      // Generate ABI files with embedded deployed addresses for the
      // outpost_ethereum_client_plugin. Each file is a JSON object with
      // { address, abi } so get_events can filter by contract address.
      const ethAbiDir = mkdirs(Path.join(dataPath, "eth-abis"))
      // Include ReserveManager + OperatorRegistry so the underwriter
      // plugin can resolve `requestSwap` (source-deposit verification
      // target on ReserveManager) and `commit` (where the underwriter
      // submits UnderwriteIntentCommit on OperatorRegistry). Without
      // these the preflight ABI lookup fails and the plugin won't
      // start its scan loop.
      const ethAbiFiles = ["OPP", "OPPInbound", "BAR", "ReserveManager", "OperatorRegistry"]
        .map(name => {
          const artifactPath = Path.join(
            cfg.ethereumPath,
            "artifacts",
            "contracts",
            "outpost",
            `${name}.sol`,
            `${name}.json`
          )
          if (!Fs.existsSync(artifactPath)) return null
          const artifact = JSON.parse(Fs.readFileSync(artifactPath, "utf-8"))
          const addr = ethAddrs[name]
          const abiWithAddr = {
            contractName: name,
            address: addr,
            abi: artifact.abi
          }
          const outPath = Path.join(ethAbiDir, `${name}.json`)
          Fs.writeFileSync(outPath, JSON.stringify(abiWithAddr, null, 2))
          return outPath
        })
        .filter((p): p is string => p !== null)

      // Derive ETH signing accounts from anvil's deterministic mnemonic.
      // Account 0 is the deployer; accounts 1..N are for batch operators.
      const anvilMnemonic = ethers.Mnemonic.fromPhrase(
        ETHBootstrapper.AnvilMnemonic
      )
      const anvilRpcUrl = toURL(cfg.ports.anvil)
      const solanaRpcUrl = toURL(cfg.ports.solanaRpc)

      // ── 10b. SOL bootstrap (if solana-path provided) ──
      // Order matters: must run before 10a so we know the SOL program ID,
      // IDL path, and validator RPC URL to splice into batch op start.cmds.
      const { programId: solProgramId, idlPath: solIdlPath } =
        await this.bootstrapSolanaOutpost(cfg, dataPath, batchOpSolKeys)

      batchOpStates.forEach((ns, i) => {
        const ethWallet = ethers.HDNodeWallet.fromMnemonic(
          anvilMnemonic,
          `${ETHBootstrapper.DerivationPath}${i + 1}`
        )
        const sigProviderName = `eth-${ns.operatorAccount}`

        const ethPrivKey = emPrivateKeyFromEthWallet(ethWallet)

        // Signature provider: <name>,<chain-kind>,<key-type>,<public-key>,KEY:<private-key>
        // Public key must be the full 64-byte uncompressed key (0x + 128 hex),
        // NOT the 20-byte address. ethers signingKey.publicKey is 0x04 + 128 hex;
        // strip the 04 prefix to match the C++ fixture format.
        const ethPubKey = "0x" + ethWallet.signingKey.publicKey.slice(4)
        const ethSigProvider = [
          sigProviderName,
          "ethereum",
          "ethereum",
          ethPubKey,
          `KEY:${ethPrivKey.toNativeString()}`
        ].join(",")

        // Outpost ethereum client: <id>,<sig-provider-name>,<rpc-url>,<chain-id>
        const ethClientSpec = [
          "eth-default",
          sigProviderName,
          anvilRpcUrl,
          String(AnvilManager.DefaultChainId)
        ].join(",")

        // Solana client spec. The ED25519 key MUST match the one linked via
        // authex in Phase 19a — otherwise the SOL outpost's active-operator
        // check rejects this node's epoch_in. We pulled the key from
        // `batchOpSolKeys` above; regenerating here would break parity.
        const solKey = batchOpSolKeys[ns.operatorAccount!]
        Assert.ok(
          solKey,
          `Missing SOL key for batch operator ${ns.operatorAccount}`
        )
        const solPub = solKey.toPublic()
        const solSigProvider = [
          `sol-${ns.operatorAccount}`,
          "solana",
          "solana",
          solPub.toNativeString(),
          `KEY:${solKey.toNativeString()}`
        ].join(",")
        const solClientSpec = `sol-default,sol-${ns.operatorAccount},${solanaRpcUrl}`

        const outpostArgs = [
          "--signature-provider",
          ethSigProvider,
          "--outpost-ethereum-client",
          ethClientSpec,
          ...ethAbiFiles.flatMap(f => ["--ethereum-abi-file", f]),
          "--batch-eth-opp-addr",
          ethOppAddr,
          "--batch-eth-opp-inbound-addr",
          ethOppInboundAddr,
          "--batch-eth-client-id",
          "eth-default",
          "--signature-provider",
          solSigProvider,
          "--outpost-solana-client",
          solClientSpec,
          "--batch-sol-client-id",
          "sol-default"
        ]

        // When a SOL outpost is configured, splice in the plugin's own CLI
        // options so the batch_operator_plugin can locate the program IDL
        // (for strongly-typed `opp_solana_outpost_client` calls) and target
        // the right on-chain program id.
        if (solProgramId && solIdlPath) {
          outpostArgs.push(
            "--solana-idl-file",
            solIdlPath,
            "--batch-sol-program-id",
            solProgramId
          )
        }

        ns.cmd.push(...outpostArgs)

        // Re-write start.cmd to include the injected outpost args
        Fs.writeFileSync(
          Path.join(ns.dataPath, "start.cmd"),
          ns.cmd.join(" ")
        )
        log.info(
          `[Phase 10a] Injected ETH${solProgramId ? "+SOL" : ""} outpost args for ${ns.operatorAccount}`
        )
      })

      // Underwriter outpost arg injection — mirrors the batch op
      // block above but populates --underwriter-* args for the
      // underwriter_plugin. Each underwriter gets an HD-derived ETH
      // signing key (slot N+i+1, past every batch op), the persisted
      // ED25519 SOL key, the OperatorRegistry contract address on ETH,
      // and the source-deposit function/instruction names so the
      // daemon can verify the user's source-chain deposit before
      // submitting commit() on both outposts.
      const opregAddr = ethAddrs.OperatorRegistry
      Assert.ok(
        opregAddr,
        "OperatorRegistry address missing from outpost-addrs.json"
      )
      underwriterStates.forEach((ns, i) => {
        const hdIndex = batchOpStates.length + i + 1
        const ethWallet = ethers.HDNodeWallet.fromMnemonic(
          anvilMnemonic,
          `${ETHBootstrapper.DerivationPath}${hdIndex}`
        )
        const sigProviderName = `eth-${ns.operatorAccount}`
        const ethPrivKey = emPrivateKeyFromEthWallet(ethWallet)
        const ethPubKey = "0x" + ethWallet.signingKey.publicKey.slice(4)
        const ethSigProvider = [
          sigProviderName,
          "ethereum",
          "ethereum",
          ethPubKey,
          `KEY:${ethPrivKey.toNativeString()}`
        ].join(",")
        const ethClientSpec = [
          "eth-default",
          sigProviderName,
          anvilRpcUrl,
          String(AnvilManager.DefaultChainId)
        ].join(",")

        const solKey = uwSolKeys[ns.operatorAccount!]
        Assert.ok(
          solKey,
          `Missing SOL key for underwriter ${ns.operatorAccount}`
        )
        const solPub = solKey.toPublic()
        const solSigProvider = [
          `sol-${ns.operatorAccount}`,
          "solana",
          "solana",
          solPub.toNativeString(),
          `KEY:${solKey.toNativeString()}`
        ].join(",")
        const solClientSpec = `sol-default,sol-${ns.operatorAccount},${solanaRpcUrl}`

        const outpostArgs = [
          "--signature-provider",
          ethSigProvider,
          "--outpost-ethereum-client",
          ethClientSpec,
          ...ethAbiFiles.flatMap(f => ["--ethereum-abi-file", f]),
          "--underwriter-eth-opreg-addr",
          opregAddr,
          "--underwriter-eth-source-deposit-function",
          "requestSwap",
          "--underwriter-eth-client-id",
          "eth-default",
          // Anvil only mines blocks on user txs in the test cluster,
          // so the underwriter would deadlock waiting for the
          // mainnet-default 12 confirmations. 1 is sufficient when
          // the chain doesn't reorg (anvil never does).
          "--underwriter-eth-min-confirmations",
          "1",
          "--signature-provider",
          solSigProvider,
          "--outpost-solana-client",
          solClientSpec,
          "--underwriter-sol-source-deposit-instruction",
          "request_swap",
          "--underwriter-sol-client-id",
          "sol-default"
        ]
        if (solProgramId && solIdlPath) {
          outpostArgs.push("--solana-idl-file", solIdlPath)
        }
        ns.cmd.push(...outpostArgs)
        Fs.writeFileSync(
          Path.join(ns.dataPath, "start.cmd"),
          ns.cmd.join(" ")
        )
        log.info(
          `[Phase 10a] Injected ETH${solProgramId ? "+SOL" : ""} outpost args for underwriter ${ns.operatorAccount}`
        )
      })

      // ── 11. Kill bios node (not needed after bootstrap) ──
      log.info("Killing bios node (not needed after bootstrap)...")
      const biosHandle = ProcessManager.get().get("node-bios")
      if (biosHandle) await biosHandle.kill()

      // ── 11b. Start batch op + underwriter nodes for initial sync ──
      // All contracts are deployed (WIRE + ETH), addresses injected. Start
      // the operator nodes so they sync chain state from the producer via P2P.
      // The verifyCallback ensures each node is synced before spawn() returns.
      log.info("Starting batch op + underwriter nodes for initial sync...")
      await Promise.all([
        ...batchOpStates.map(ns =>
          this.launchFromCmd(toNodeLabel(ns.nodeId), ns.cmd, ns.dataPath, {
            verifyPort: ns.port
          })
        ),
        ...underwriterStates.map(ns =>
          this.launchFromCmd(toNodeLabel(ns.nodeId), ns.cmd, ns.dataPath, {
            verifyPort: ns.port
          })
        )
      ])
      log.info("Batch op + underwriter nodes synced")

      // ── 11c. Persist per-operator key material onto NodeStates ──
      // Flow tests reconstruct operator wallets via
      // `FlowTestContext.getWallet(chain, type)`; those factories need the
      // WIRE K1/BLS and (optionally) SOL ED private material on disk to
      // recreate the same signing identities the bootstrap installed in
      // kiod / on the sig-provider. ETH-side material is omitted because
      // wallets are derived deterministically from
      // `ETHBootstrapper.AnvilMnemonic` + HD index.
      batchOpStates.forEach((ns, i) => {
        const k = batchOpKeys[i]
        const solKey = batchOpSolKeys[ns.operatorAccount!]
        ns.keys = {
          wireK1: { publicKey: k.k1.publicKey, privateKey: k.k1.privateKey },
          wireBls: {
            publicKey: k.bls.publicKey,
            privateKey: k.bls.privateKey,
            proofOfPossession: k.bls.proofOfPossession
          },
          ...(solKey
            ? {
                solEd: {
                  publicKey: solKey.toPublic().toString(),
                  privateKey: solKey.toString()
                }
              }
            : {})
        }
      })
      underwriterStates.forEach((ns, i) => {
        const k = uwKeys[i]
        const solKey = uwSolKeys[ns.operatorAccount!]
        ns.keys = {
          wireK1: { publicKey: k.k1.publicKey, privateKey: k.k1.privateKey },
          wireBls: {
            publicKey: k.bls.publicKey,
            privateKey: k.bls.privateKey,
            proofOfPossession: k.bls.proofOfPossession
          },
          // Persist the underwriter's ED25519 SOL key so the
          // post-`start()` collateral deposit (Phase 11d) signs with
          // the same key that was authex-linked at Phase 19a — and so
          // a subsequent `start()` from saved state can still recover
          // it. Mirrors the batch-op persistence above.
          ...(solKey
            ? {
                solEd: {
                  publicKey: solKey.toPublic().toString(),
                  privateKey: solKey.toString()
                }
              }
            : {})
        }
      })

      // ── 11d. Deposit underwriter collateral ─────────────────────────
      //
      // One-shot setup step that submits the per-underwriter
      // collateral plan (defaults or operator-supplied via
      // `--underwriter-collateral-json-file`) on each outpost.
      // Belongs in `create` (not `run`) because it's a one-time
      // bootstrap action: depot-side balance crediting is NOT
      // idempotent, so running it on every `run` would over-credit.
      //
      // anvil was shut down at the end of the ETH bootstrap (Phase 10)
      // so it could dump its state. We restart it briefly here from
      // the dumped state, submit the ETH-leg deposits + the SOL-leg
      // deposits (SOL validator is still alive from Phase 10b), then
      // shut anvil back down so the post-deposit state is captured
      // in the same dump file `run` will load from. Result: when
      // `run` restarts everything, the deposit txs are already on
      // anvil's chain history and batch operators pick up the logs
      // → emit `OPERATOR_ACTION(DEPOSIT_REQUEST)` OPP envelopes → the
      // depot credits the underwriter's balance the normal async way.
      const anvilStatePath = Path.join(dataPath, ClusterManager.AnvilStateSubpath)
      if (
        cfg.underwriterCollateral !== undefined &&
        cfg.underwriterCollateral.length === underwriterStates.length &&
        underwriterStates.length > 0
      ) {
        log.info("[Phase 11d] Restarting anvil to deposit underwriter collateral...")
        const anvilMgr = await AnvilManager.create({
          binary: cfg.executables.anvil,
          port: cfg.ports.anvil,
          stateFile: Path.join(anvilStatePath, "anvil.json")
        })
        await anvilMgr.start()
        try {
          const uwContexts: UnderwriterTools.Collateral.DepositContext[] =
            underwriterStates.map((uw, idx) => ({
              account: uw.operatorAccount!,
              // HD index aligns with Phase 19a authex linking: batch
              // ops occupy `1..batchOpCount`, underwriters follow at
              // `batchOpCount + 1..`.
              ethHdIndex: batchOpStates.length + idx + 1,
              solPrivateKey: uwSolKeys[uw.operatorAccount!]
            }))
          await UnderwriterTools.Collateral.deposit({
            ethereumPath: cfg.ethereumPath,
            solanaPath: cfg.solanaPath,
            anvilRpcUrl: toURL(cfg.ports.anvil),
            solanaRpcUrl: toURL(cfg.ports.solanaRpc),
            collateral: cfg.underwriterCollateral,
            underwriters: uwContexts
          })
          log.info(
            `[Phase 11d] Deposited collateral for ${underwriterStates.length} underwriter(s)`
          )
        } finally {
          // Stop anvil so the post-deposit state is dumped into the
          // state file `run` will later load from.
          await anvilMgr.stop()
        }
      } else if (underwriterStates.length > 0) {
        log.warn(
          "[Phase 11d] No underwriterCollateral plan on ClusterConfig; skipping deposits"
        )
      }

      // ── 12. Persist state (bios excluded, matching Python _save_state) ──
      const clusterState: ClusterState = {
        pnodes: cfg.nodeCount,
        totalNodes: cfg.nodeCount,
        prodCount: cfg.producerCount,
        topo: "mesh",
        nodes: nodeStates,
        batchOperatorNodes: batchOpStates,
        underwriterNodes: underwriterStates,
        anvilStatePath: Path.join(dataPath, ClusterManager.AnvilStateSubpath),
        solanaLedgerPath: Path.join(
          dataPath,
          ClusterManager.SolanaLedgerSubpath
        ),
        walletPath,
        solanaPrograms: this.solanaPrograms,
        solanaIdlPath: this.solanaIdlPath
      }
      this._state = clusterState
      this.saveState(clusterPath, clusterState)

      // ── 12. Shut everything down ──
      log.info("Shutting down remaining nodes...")
      await this.stopDebuggingServer()
      await ProcessManager.get().killAll()
      await sleep(ClusterManager.ShutdownDelayMs)

      log.info(`Cluster created and bootstrapped: ${clusterPath}`)
      return this
    } finally {
      getValue(() => this.onStopDeferred.resolve())
    }
  }

  /**
   * Start all nodes from previously saved cluster state (the `run` command).
   * Strips --genesis-json/--genesis-timestamp and adds --enable-stale-production.
   */
  async start(): Promise<ClusterManager> {
    if (!this.state) {
      throw new Error(
        "No cluster state loaded. Call create() or loadState() first."
      )
    }

    // Start kiod wallet daemon
    const kiod = await KiodManager.create({
      binary: this.config.executables.kiod,
      walletPath: this.state.walletPath,
      port: this.config.ports.kiod
    })
    await kiod.start()

    log.info(`Starting ${this.state.nodes.length} producer node(s)...`)

    // Clear finalizer safety state (safety.dat) before restart.
    // If a previous run deleted blocks or forks, the saved FSI lock may point
    // to a block that no longer exists. A fresh safety.dat lets the finalizer
    // start voting immediately rather than blocking on a stale lock.
    this.state.nodes.forEach(ns => {
      const safetyDat = Path.join(
        ns.dataPath,
        ClusterManager.FinalizersSubpath,
        ClusterManager.SafetyDatFile
      )
      if (Fs.existsSync(safetyDat)) {
        Fs.unlinkSync(safetyDat)
        log.info(`Cleared stale FSI for node ${ns.nodeId}`)
      }
    })

    // Start producer nodes with sync verification
    await Promise.all(
      this.state.nodes.map(ns => {
        const relaunchCmd = buildRelaunchCmd(ns.cmd)
        log.info(
          `  Starting node ${ns.nodeId} (port ${ns.port}): ${ns.producerName ?? "non-producer"}`
        )
        return this.launchFromCmd(
          toNodeLabel(ns.nodeId),
          relaunchCmd,
          ns.dataPath,
          {
            verifyPort: ns.port
          }
        )
      })
    )
    log.info(`Producer nodes started (${this.state.nodes.length})`)

    // Break the producer-pause deadlock on every fresh start.
    // The production_pause_vote_tracker starts with no vote history (epoch 0).
    // Without a resume call, the producer stalls waiting for votes that can't
    // arrive until it produces at least one block — a chicken-and-egg freeze.
    // force_unpause() resets the tracker so the first block can be produced,
    // after which the BLS finalizer votes normally and the tracker stays clear.
    await sleep(ClusterManager.PreResumeSettleMs)
    await Promise.all(
      this.state.nodes
        .filter(ns => ns.isProducer)
        .map(async ns => {
          try {
            const resp = await fetch(
              `${toURL(ns.port)}/v1/producer/resume`,
              { method: "POST" }
            )
            log.info(`Resumed producer on node ${ns.nodeId}: ${resp.status}`)
          } catch (err) {
            log.warn(`Failed to resume producer on node ${ns.nodeId}: ${err}`)
          }
        })
    )

    // Start debugging server (batch ops connect to it via --ext-debugging-server)
    await this.startDebuggingServer()

    // Start batch operator nodes (read-mode=irreversible — sync from P2P)
    log.info(
      `Starting ${(this.state.batchOperatorNodes ?? []).length} batch op node(s)...`
    )
    await Promise.all(
      (this.state.batchOperatorNodes ?? []).map(ns => {
        log.info(
          `  Starting batch op ${ns.nodeId} (port ${ns.port}): ${ns.operatorAccount}`
        )
        return this.launchFromCmd(toNodeLabel(ns.nodeId), ns.cmd, ns.dataPath, {
          verifyPort: ns.port,
          extraArgs: ["--enable-stale-production"]
        })
      })
    )
    log.info("Batch op nodes started and synced")

    // Start underwriter nodes
    log.info(
      `Starting ${(this.state.underwriterNodes ?? []).length} underwriter node(s)...`
    )
    await Promise.all(
      (this.state.underwriterNodes ?? []).map(ns => {
        log.info(
          `  Starting underwriter ${ns.nodeId} (port ${ns.port}): ${ns.operatorAccount}`
        )
        return this.launchFromCmd(toNodeLabel(ns.nodeId), ns.cmd, ns.dataPath, {
          verifyPort: ns.port,
          extraArgs: ["--enable-stale-production"]
        })
      })
    )
    log.info("Underwriter nodes started and synced")

    // Start anvil (ETH local node)
    if (this.state.anvilStatePath) {
      const anvilManager = await AnvilManager.create({
        binary: this.config.executables.anvil,
        port: this.config.ports.anvil,
        stateFile: Path.join(this.state.anvilStatePath, "anvil.json"),
        // Run phase only: contracts are already deployed (loaded from state), so
        // interval mining + shallow finality are safe here (no hardhat deploy to
        // break) and let the outpost clients' `finalized` inbound reads progress.
        slotsInAnEpoch: AnvilManager.SlotsInAnEpoch,
        blockTimeSec: AnvilManager.BlockTimeSec
      })
      await anvilManager.start()
    }

    // Start solana-test-validator from the persisted ledger. Bootstrap ran
    // during `create`, so PDAs and batch operator balances survive restarts.
    if (this.state.solanaLedgerPath) {
      const solManager = await SolanaValidatorManager.create({
        binary: this.config.executables.solanaTestValidator,
        rpcPort: this.config.ports.solanaRpc,
        faucetPort: this.config.ports.solanaFaucet,
        ledgerPath: this.state.solanaLedgerPath,
        programs: this.state.solanaPrograms ?? []
      })
      await solManager.start()
    }

    log.info("All nodes + external chains started")

    return this
  }

  /**
   * Start & wait for stop command
   */
  async startAndWait() {
    try {
      await this.start()
      log.info("wire-test-cluster: cluster started, press Ctrl+C to stop")
      await this.onStopDeferred.promise
      return this
    } finally {
      getValue(() => this.onStopDeferred.resolve())
    }
  }
  /** Stop all running nodes and the debugging server. */
  async stop(): Promise<void> {
    log.info("Stopping cluster...")
    await this.stopDebuggingServer()
    await ProcessManager.get()
      .killAll()
      .finally(() => {
        getValue(() => this.onStopDeferred.resolve())
      })
    log.info("Cluster stopped")
  }

  /** Load cluster state from a chain directory's cluster-state.json. */
  loadState(): ClusterManager {
    const stateFile = Path.join(this.clusterPath, ClusterFiles.StateFilename)
    if (!Fs.existsSync(stateFile)) {
      throw new Error(`No cluster state at ${stateFile}`)
    }
    this._state = JSON.parse(
      Fs.readFileSync(stateFile, "utf-8")
    ) as ClusterState
    log.info(`Loaded cluster state: ${this.state.nodes.length} nodes`)
    return this
  }

  // ── Private helpers ──

  /**
   * Creates a verifyCallback for nodeop processes that polls get_info
   * until the node reports a synced head block.
   */
  /**
   * Creates a verifyCallback that polls a nodeop instance until it has
   * synced enough of the chain to query the sysio.epoch contract.
   * This confirms the node is past the full bootstrap sequence.
   */
  static nodeopSyncVerify(
    httpPort: number
  ): (handle: ProcessHandle) => Promise<boolean> {
    const baseUrl = toURL(httpPort)
    return async () => {
      try {
        // First check the node is responding at all
        const infoResp = await fetch(`${baseUrl}/v1/chain/get_info`, {
          signal: AbortSignal.timeout(
            ClusterManager.NodeReadinessFetchTimeoutMs
          )
        })
        if (!infoResp.ok) return false

        // Then verify it has synced far enough to read sysio.epoch state
        const tableResp = await fetch(`${baseUrl}/v1/chain/get_table_rows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            json: true,
            code: "sysio.epoch",
            scope: "sysio.epoch",
            table: "epochstate",
            limit: 1
          }),
          signal: AbortSignal.timeout(
            ClusterManager.NodeReadinessFetchTimeoutMs
          )
        })
        if (!tableResp.ok) return false
        const result = (await tableResp.json()) as { rows: unknown[] }
        return result.rows.length > 0
      } catch {
        return false
      }
    }
  }

  /** Launch a nodeop process from a start.cmd args array, optionally verifying sync. */
  private async launchFromCmd(
    label: string,
    cmd: string[],
    cwd: string,
    opts?: { verifyPort?: number; extraArgs?: string[] }
  ): Promise<ProcessHandle> {
    return ProcessManager.get().spawn({
      label,
      command: cmd[0],
      args: [...cmd.slice(1), ...(opts?.extraArgs ?? [])],
      cwd,
      ...(opts?.verifyPort
        ? {
            verifyCallback: ClusterManager.nodeopSyncVerify(opts.verifyPort),
            verifyTimeoutMs: ClusterManager.NodeSyncTimeoutMs,
            verifyIntervalMs: ClusterManager.NodeSyncPollIntervalMs
          }
        : {})
    })
  }

  /** Persist cluster state to cluster-state.json. */
  private saveState(clusterPath: string, state: ClusterState): void {
    const stateFile = Path.join(clusterPath, ClusterFiles.StateFilename)
    Fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8")
    log.info(`Cluster state saved to ${stateFile}`)
  }
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Bootstrap helpers
// ---------------------------------------------------------------------------

/**
 * Register the bootstrap node owner via the production node-owner registration flow.
 *
 * Mirrors what the OPP NFT-claim depot (sysio.msgch) inline-sends for a real claim, driving the two
 * sysio.roa actions directly (the same way flow-node-owner-nft does):
 *   1. `newnameduser` creates {@link BOOTSTRAP_NODE_OWNER} with the dev K1 key as owner/active and a
 *      finite, pool-gifted RAM allocation.
 *   2. `nodeownreg` registers it at tier 1, records the (fake) depositor EM eth key as a sysio.authex
 *      link, and allocates the tier-1 ROA reserve it then issues operator/underwriter policies from.
 *
 * Deliberately does NOT use `sysio.roa::forcereg` (the admin shortcut): production node owners only
 * enter through `nodeownreg`, so the bootstrap exercises the same path. Preconditions: ROA active and
 * the `sysio.roa -> sysio.authex@sysio.code` delegation present (so the inline `recordlink`
 * authorizes) -- both hold once Phase 14f has run.
 */
async function setupNodeOwner(clio: Clio): Promise<void> {
  await pushNewNamedUser(
    clio,
    BOOTSTRAP_NODE_OWNER,
    DEV_K1_PUBLIC_KEY,
    NodeOwnerTier.T1
  )
  await pushNodeOwnerReg(
    clio,
    BOOTSTRAP_NODE_OWNER,
    NodeOwnerTier.T1,
    freshEthPubEm(),
    DEV_K1_PUBLIC_KEY
  )

  // nodeownreg soft-fails on a claim-payload problem (records a REJECTED nodeownerreg audit row and
  // returns instead of throwing), so confirm the nodeowners row exists. A silently-unregistered owner
  // would otherwise surface only later as a cryptic "Only Node Owners can issue policies" at Phase 18.
  const reg = await readNodeOwner(clio, BOOTSTRAP_NODE_OWNER)
  if (!reg) {
    const audit = await readNodeOwnerReg(clio, BOOTSTRAP_NODE_OWNER)
    throw new Error(
      `Bootstrap node owner ${BOOTSTRAP_NODE_OWNER} was not registered by nodeownreg` +
        (audit
          ? ` (rejected: status=${audit.status}, reason=${audit.reason})`
          : " (no audit row found)")
    )
  }
}

async function bootstrapChain(
  clio: Clio,
  cfg: ClusterConfig,
  biosHttpUrl: string,
  nodeStates: NodeState[],
  nodeKeys: NodeKeySet[],
  batchOpStates: NodeState[],
  underwriterStates: NodeState[],
  batchOpSolKeys: Record<string, PrivateKey>,
  uwSolKeys: Record<string, PrivateKey>
): Promise<void> {
  log.info("=== Bootstrap sequence starting ===")

  const contractsPath = Path.join(cfg.buildPath, "contracts")
  const libTestingContracts = Path.join(
    cfg.buildPath,
    "libraries",
    "testing",
    "contracts"
  )

  function resolveContractPath(contractName: string): string {
    const buildPath = Path.join(contractsPath, contractName)
    if (Fs.existsSync(Path.join(buildPath, `${contractName}.wasm`)))
      return buildPath
    const libPath = Path.join(libTestingContracts, contractName)
    if (Fs.existsSync(Path.join(libPath, `${contractName}.wasm`)))
      return libPath
    throw new Error(
      `Contract ${contractName} not found in ${buildPath} or ${libPath}`
    )
  }

  const producerNames = range(cfg.producerCount).map(toProducerName)

  // ── Phase 1: Wallet already created with all keys imported (before nodeop launch) ──
  log.info("[Phase 1] Wallet ready (keys already imported)")

  // ── Phase 2: Deploy sysio.bios contract ──
  log.info("[Phase 2] Deploying sysio.bios...")
  const biosContractPath = resolveContractPath("sysio.bios")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio",
        biosContractPath,
        "sysio.bios.wasm",
        "sysio.bios.abi"
      ),
    {
      label: "deploy sysio.bios",
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryHeavyDelayMs
    }
  )
  log.info("[Phase 2] sysio.bios deployed")

  // ── Phase 3: Activate ALL protocol features ──
  log.info("[Phase 3] Activating protocol features...")
  const featuresResp = await fetch(
    `${biosHttpUrl}/v1/producer/get_supported_protocol_features`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }
  )
  if (!featuresResp.ok)
    throw new Error(
      `Failed to get protocol features: ${featuresResp.statusText}`
    )
  const rawFeatures = (await featuresResp.json()) as Array<{
    feature_digest: string
    specification?: Array<{ name: string; value: string }>
  }>
  const featureList = Array.isArray(rawFeatures) ? rawFeatures : []
  let activatedCount = 0
  await Bluebird.each(featureList, async feature => {
    const digest = feature.feature_digest
    if (!digest) return
    const slug_name = feature.specification?.find(
      s => s.name === "builtin_feature_codename"
    )?.value
    if (slug_name === "PREACTIVATE_FEATURE") return
    try {
      await clio.activateFeature(digest)
      activatedCount++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        !msg.includes("already activated") &&
        !msg.includes("already been activated")
      ) {
        log.warn(
          "[Phase 3] Feature activation issue: {} - {}",
          slug_name ?? digest,
          msg
        )
      }
    }
  })
  await sleep(ClusterManager.ClioRetryLightDelayMs)
  log.info("[Phase 3] Activated {} protocol features", activatedCount)

  // ── Phase 4: BLS instant finality setup ──
  // Build finalizer list from producer node BLS keys (matching Python _set_finalizers)
  log.info("[Phase 4] BLS instant finality setup...")
  try {
    const finalizerNodes = nodeStates
      .filter(ns => ns.isProducer)
      .map((ns, i) => ({
        description: `finalizer-${ns.nodeId}`,
        weight: 1,
        public_key: nodeKeys[i].bls.publicKey,
        pop: nodeKeys[i].bls.proofOfPossession
      }))

    Assert.ok(
      finalizerNodes.length > 0,
      "No producer nodes with BLS keys — instant finality requires at least one finalizer"
    )
    const threshold = Math.floor((finalizerNodes.length * 2) / 3) + 1
    await clio.pushActionAndWait<SystemContracts.SysioBiosSetfinalizerAction>(
      "sysio",
      "setfinalizer",
      { finalizer_policy: { threshold, finalizers: finalizerNodes } },
      "sysio@active"
    )
    log.info(
      `[Phase 4] Activated instant finality: ${finalizerNodes.length} finalizer(s), threshold=${threshold}`
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[Phase 4] Instant finality activation FAILED: ${msg}`)
  }

  // ── Phase 5: Create the bring-up-essential accounts only (sysio.roa, sysio.acct) ──
  // Everything else — producers AND the rest of the sysio.* system accounts — is created later (Phase 11a),
  // after sysio.system is deployed and ROA is active, so system::newaccount gifts each account's RAM from the
  // sysio pool (set_resource_limits 0 + transfer_ram) — finite, never unlimited. These two must exist now:
  // sysio.roa hosts the contract deployed in Phase 11, and activateroa seeds sysio.acct's bucket. They are
  // transiently unlimited (bios has no gifting newaccount) until activateroa sets them finite.
  log.info("[Phase 5] Creating bring-up accounts (sysio.roa, sysio.acct)...")
  // owner = active = sysio@active (no standalone key): every sysio.* account is governed by sysio, the
  // production model. These two are created under bios (pre-ROA), so they are transiently unlimited until
  // activateroa sets them finite -- but their authority is sysio@active from birth.
  await Bluebird.each(["sysio.roa", "sysio.acct"], name =>
    retry(() => createSysioAccount(clio, name), {
      label: `create account ${name}`,
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryLightDelayMs
    })
  )
  log.info("[Phase 5] Bring-up accounts created")

  // ── Phase 7: Deploy sysio.system ──
  log.info("[Phase 7] Deploying sysio.system...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio",
        resolveContractPath("sysio.system"),
        "sysio.system.wasm",
        "sysio.system.abi"
      ),
    {
      label: "deploy sysio.system",
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryHeavyDelayMs
    }
  )
  log.info("[Phase 7] sysio.system deployed")

  // (Producer accounts, the producer schedule/handoff, and the remaining sysio.* accounts now happen AFTER ROA
  //  activation — see Phases 11d/11e — so every account is created via system::newaccount with RAM gifted from
  //  the sysio pool. The genesis `sysio` producer carries the chain, finalized by the producer nodes' BLS keys,
  //  until that handoff. sysio.token likewise deploys post-ROA via setsyscode — see Phase 11c.)

  // ── Phase 11: Deploy sysio.roa ──
  log.info("[Phase 11] Deploying sysio.roa...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio.roa",
        resolveContractPath("sysio.roa"),
        "sysio.roa.wasm",
        "sysio.roa.abi"
      ),
    {
      label: "deploy sysio.roa",
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryHeavyDelayMs
    }
  )
  await clio.setPriv("sysio.roa")
  await clio.pushActionAndWait<SystemContracts.SysioRoaActivateroaAction>(
    "sysio.roa",
    "activateroa",
    { total_sys: "75496.0000 SYS", bytes_per_unit: 104 },
    "sysio.roa@active"
  )
  log.info("[Phase 11] sysio.roa deployed")

  // ── Phase 11a: Create producers + remaining system accounts (pool-gifted) ──
  // Created now (after sysio.system + activateroa) so system::native::newaccount gifts each account's RAM from
  // the sysio pool — set_resource_limits(new,0,0,0) + transfer_ram(sysio,new,newaccount_ram) — making them
  // FINITE, never unlimited. Producers keep their own block-signing key (DEV_K1); every sysio.* system account
  // is created with owner = active = sysio@active (no standalone key) via createSysioAccount, so chain
  // governance owns it — the production model. The bootstrap node owner is NOT registered here: it is created
  // post-bootstrap via the real sysio.roa::nodeownreg flow (see setupNodeOwner below), which needs ROA active
  // + the authex delegation.
  log.info(
    "[Phase 11a] Creating producer + remaining system accounts (pool-gifted)..."
  )
  await Bluebird.each(producerNames, name =>
    retry(
      () =>
        clio.createAccount("sysio", name, DEV_K1_PUBLIC_KEY, DEV_K1_PUBLIC_KEY),
      {
        label: `create producer ${name}`,
        maxAttempts: ClusterManager.ClioRetryAttempts,
        delayMs: ClusterManager.ClioRetryLightDelayMs
      }
    )
  )

  const remainingSysAccounts = SYSTEM_ACCOUNTS.filter(
    a => a !== "sysio.roa" && a !== "sysio.acct"
  )
  await Bluebird.each(remainingSysAccounts, async acctName => {
    try {
      await createSysioAccount(clio, acctName)
    } catch (err: unknown) {
      if (!isAccountAlreadyExistsError(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to create ${acctName}: ${msg}`)
      }
    }
  })
  log.info(
    `[Phase 11a] Created ${producerNames.length} producer + ${remainingSysAccounts.length} system accounts`
  )

  // ── Phase 11b: Set producers + hand off from the genesis sysio producer ──
  log.info("[Phase 11b] Setting producers...")

  // Extract each node's K1 public key from its start.cmd signature-provider arg
  // to use as block_signing_key (matches Python: keys["public"])
  const K1PubKeyPattern = /^wire-(PUB_K1_\S+),wire,wire,/
  const LegacySysPubKeyPattern = /^wire-(SYS\S+),wire,wire,/

  const extractNodeK1PubKey = (ns: NodeState): string => {
    const match = ns.cmd
      .map(
        arg => arg.match(K1PubKeyPattern) ?? arg.match(LegacySysPubKeyPattern)
      )
      .find((m): m is RegExpMatchArray => m !== null)
    return match ? match[1] : DEV_K1_PUBLIC_KEY
  }

  // Build producer schedule: map each producer name to the signing key of the node that hosts it
  const prodSchedule = producerNames.slice(0, MAX_PRODUCERS).map(name => {
    const hostNode =
      nodeStates.find(ns =>
        ns.cmd.some(a => a === name && ns.cmd.includes("--producer-name"))
      ) ??
      nodeStates.find(ns =>
        ns.cmd.some(
          (arg, i) => arg === "--producer-name" && ns.cmd[i + 1] === name
        )
      )
    const sigKey = hostNode ? extractNodeK1PubKey(hostNode) : DEV_K1_PUBLIC_KEY
    return { producer_name: name, block_signing_key: sigKey }
  })

  await clio.pushActionAndWait<SystemContracts.SysioSystemSetprodkeysAction>(
    "sysio",
    "setprodkeys",
    { schedule: prodSchedule },
    "sysio@active"
  )
  log.info("[Phase 11b] Waiting for producer handoff (timeout 90s)...")
  const handoffDeadline = Date.now() + ClusterManager.HandoffTimeoutMs
  let handoffComplete = false
  while (Date.now() < handoffDeadline) {
    try {
      const info = await clio.getInfo()
      if (info.head_block_producer && info.head_block_producer !== "sysio") {
        log.info(
          `[Phase 11b] Producer handoff: ${info.head_block_producer as string}`
        )
        handoffComplete = true
        break
      }
    } catch (err: any) {
      // getInfo may fail transiently during handoff — retry
      log.debug(
        `[Phase 11b] Handoff poll error (retrying): ${err.message?.slice(0, 100)}`
      )
    }
    await sleep(ClusterManager.HandoffPollIntervalMs)
  }
  Assert.ok(
    handoffComplete,
    `Producer handoff failed within ${ClusterManager.HandoffTimeoutMs}ms`
  )

  // ── Phase 11c: Deploy sysio.token (setsyscode, post-ROA) + distribute ──
  // Moved after activateroa so the token contract is deployed privileged with its code RAM gifted from the
  // sysio pool (setsyscode), not raw setcode+setpriv. Token create/issue/transfer follow as before.
  log.info("[Phase 11c] Deploying sysio.token + distributing...")
  await retry(
    () =>
      deploySysContract(
        clio,
        "sysio.token",
        Path.join(resolveContractPath("sysio.token"), "sysio.token.wasm"),
        Path.join(resolveContractPath("sysio.token"), "sysio.token.abi")
      ),
    {
      label: "deploy sysio.token",
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryHeavyDelayMs
    }
  )
  await clio.pushActionAndWait<SystemContracts.SysioTokenCreateAction>(
    "sysio.token",
    "create",
    { issuer: "sysio", maximum_supply: ClusterManager.InitialTokenSupply },
    "sysio.token@active"
  )
  await clio.pushActionAndWait<SystemContracts.SysioTokenIssueAction>(
    "sysio.token",
    "issue",
    { to: "sysio", quantity: ClusterManager.InitialTokenSupply, memo: "initial issue" },
    "sysio@active"
  )
  await Bluebird.each(producerNames, name =>
    clio.pushActionAndWait<SystemContracts.SysioTokenTransferAction>(
      "sysio.token",
      "transfer",
      { from: "sysio", to: name, quantity: ClusterManager.ProducerInitialGrant, memo: "init" },
      "sysio@active"
    )
  )
  log.info("[Phase 11c] sysio.token deployed + distributed")

  // ── Phase 12: Deploy sysio.authex ──
  log.info("[Phase 12] Deploying sysio.authex...")
  await retry(
    () =>
      deploySysContract(
        clio,
        "sysio.authex",
        Path.join(resolveContractPath("sysio.authex"), "sysio.authex.wasm"),
        Path.join(resolveContractPath("sysio.authex"), "sysio.authex.abi")
      ),
    {
      label: "deploy sysio.authex",
      maxAttempts: ClusterManager.ClioRetryAttempts,
      delayMs: ClusterManager.ClioRetryHeavyDelayMs
    }
  )
  await grantSysioCode(clio, "sysio.authex")
  await clio.pushTransactionAndWait({
    account: "sysio",
    name: "updateauth",
    data: {
      account: "sysio",
      permission: "active",
      parent: "owner",
      auth: {
        threshold: 1,
        keys: [
          {
            key: DEV_K1_PUBLIC_KEY,
            weight: 1
          }
        ],
        accounts: [
          {
            permission: {
              actor: "sysio.authex",
              permission: "sysio.code"
            },
            weight: 1
          }
        ]
      }
    },
    authorization: [
      {
        actor: "sysio",
        permission: "active"
      }
    ]
  })

  log.info("[Phase 12] sysio.authex deployed")

  // ── Phase 13: System init ──
  log.info("[Phase 13] System init...")
  await clio.pushActionAndWait<SystemContracts.SysioSystemInitAction>(
    "sysio",
    "init",
    { version: 0, core: "4,SYS" },
    "sysio@active"
  )
  log.info("[Phase 13] System initialized")

  // ── Phase 14: Deploy OPP contracts ──
  log.info("[Phase 14] Deploying OPP contracts...")
  await Bluebird.each(
    Object.entries(OPP_CONTRACT_PATHS),
    async ([contractName, relPath]) => {
      const contractPath = Path.join(cfg.buildPath, relPath)
      if (!Fs.existsSync(Path.join(contractPath, `${contractName}.wasm`))) {
        log.warn(`[Phase 14] ${contractName} not found, skipping`)
        return
      }
      await retry(
        () =>
          deploySysContract(
            clio,
            contractName,
            Path.join(contractPath, `${contractName}.wasm`),
            Path.join(contractPath, `${contractName}.abi`)
          ),
        {
          label: `deploy ${contractName}`,
          maxAttempts: ClusterManager.ClioRetryAttempts,
          delayMs: ClusterManager.ClioRetryHeavyDelayMs
        }
      )
    }
  )
  log.info("[Phase 14] OPP contracts deployed")

  // ── Phase 14a–c: Grant sysio.code on OPP contract authorities ──
  // Required for inline actions (epoch advance, evalcons, processprod, etc.).
  // Iterates the single source of truth — keeps deploy + grant lists in sync.
  await Bluebird.each(OPP_SYSTEM_ACCOUNTS, account =>
    grantSysioCode(clio, account)
  )

  // ── Phase 14d: Cross-contract delegation for inline-action dispatch ──
  // sysio.msgch's `dispatch_operator_action` invokes `sysio.opreg::deposit`
  // and `sysio.opreg::queuewtdw` inline. Both opreg actions check
  // `require_auth(get_self()=sysio.opreg)`, so msgch must declare
  // `permission_level{sysio.opreg, active}` on its inline action. For the
  // chain's inline-send auth check to accept that declaration, `opreg.active`
  // must trust `sysio.msgch@sysio.code` — added here, mirroring the
  // sysio↔sysio.authex grant in Phase 12 above.
  await clio.pushTransactionAndWait({
    account: "sysio",
    name: "updateauth",
    data: {
      account: "sysio.opreg",
      permission: "active",
      parent: "owner",
      // sysio@active base (no key) + msgch@sysio.code (cross-contract caller) + opreg@sysio.code (own
      // inline sends); the helper prepends sysio@active and sorts the accounts list.
      auth: sysioActiveCodeAuthority(["sysio.msgch", "sysio.opreg"])
    },
    authorization: [{ actor: "sysio.opreg", permission: "owner" }]
  })

  // ── Phase 14e: Cross-contract delegation for the NodeOwnerRegistration claim ──
  // sysio.msgch's `dispatch_node_owner_reg` inline-sends `sysio.roa::newnameduser` (account
  // create) and `sysio.roa::nodeownreg` (register + record ETH link). Both check
  // `require_auth(get_self()=sysio.roa)`, so msgch declares `permission_level{sysio.roa, active}`;
  // the chain accepts that only if `roa.active` trusts `sysio.msgch@sysio.code`. `sysio.roa@sysio.code`
  // is retained so sysio.roa's own inline `newaccount` (newuser / newnameduser) stays authorized.
  await clio.pushTransactionAndWait({
    account: "sysio",
    name: "updateauth",
    data: {
      account: "sysio.roa",
      permission: "active",
      parent: "owner",
      // sysio@active base (no key) + msgch@sysio.code + roa@sysio.code; the helper prepends sysio@active
      // and sorts the accounts list as the authority encoding requires.
      auth: sysioActiveCodeAuthority(["sysio.msgch", "sysio.roa"])
    },
    authorization: [{ actor: "sysio.roa", permission: "owner" }]
  })

  // ── Phase 14f: sysio.roa → sysio.authex delegation for recordlink ──
  // sysio.roa::nodeownreg inline-sends `sysio.authex::recordlink`
  // (`require_auth(get_self()=sysio.authex)`), declaring `permission_level{sysio.authex, active}`;
  // the chain accepts that only if `authex.active` trusts `sysio.roa@sysio.code`.
  // `sysio.authex@sysio.code` is retained for authex's own inline sends.
  await clio.pushTransactionAndWait({
    account: "sysio",
    name: "updateauth",
    data: {
      account: "sysio.authex",
      permission: "active",
      parent: "owner",
      // sysio@active base (no key) + authex@sysio.code + roa@sysio.code; the helper prepends sysio@active
      // and sorts the accounts list.
      auth: sysioActiveCodeAuthority(["sysio.authex", "sysio.roa"])
    },
    authorization: [{ actor: "sysio.authex", permission: "owner" }]
  })

  // ===========================================================================
  // === PRODUCTION BOOTSTRAP COMPLETE ===
  //
  // Everything ABOVE stands up the core chain exactly as production will: bios then sysio.system
  // (raw, on the `sysio` account); sysio.roa (raw) + activateroa establishing the single sysio RAM
  // pool; every other privileged system contract (token, authex, and the OPP set) deployed via
  // sysio.roa::setsyscode/setsysabi with its code RAM gifted from that pool; all accounts finite and
  // pool-gifted (no unlimited accounts); producers set + handed off; and the inline-auth (sysio.code)
  // delegations wired. At this point the chain is fully bootstrapped and self-sufficient.
  //
  // Everything BELOW is POST-BOOTSTRAP OPERATIONS SETUP — the operations layer (cross-chain config,
  // node owners, operators, underwriters, epochs). In production this is NOT done by the bootstrap
  // process: real node owners register through the NFT-claim -> sysio.roa::nodeownreg flow and then
  // provision operators. The cluster performs it inline only so e2e flows have a live operations
  // layer to test against. It is kept faithful to production — no admin shortcuts (no forcereg).
  // ===========================================================================

  // ── Post-bootstrap: register the bootstrap node owner (real nodeownreg flow, fake EM eth) ──
  // The "actual node owner" that sets up operations below. Runs here (not in Phase 11a) because
  // nodeownreg needs ROA active AND the Phase 14f sysio.roa->sysio.authex@sysio.code delegation so its
  // inline recordlink authorizes. It must precede Phase 18 (operators), which issues ROA policies from
  // BOOTSTRAP_NODE_OWNER as the registered node owner.
  log.info("[Post-bootstrap] Registering bootstrap node owner via nodeownreg...")
  await setupNodeOwner(clio)
  log.info(
    `[Post-bootstrap] Bootstrap node owner ${BOOTSTRAP_NODE_OWNER} registered (tier 1)`
  )

  // ── Phase 15: Configure sysio.epoch ──
  log.info("[Phase 15] Configuring sysio.epoch...")
  // batch_operator_minimum_active must equal operators_per_epoch * batch_op_groups
  // For small clusters, scale down to match
  const batchOpMin = cfg.batchOperatorCount
  const batchOpGroups = Math.min(3, batchOpMin)
  const opsPerEpoch =
    batchOpGroups > 0 ? Math.ceil(batchOpMin / batchOpGroups) : 1
  const adjustedMin = opsPerEpoch * batchOpGroups
  await clio.pushActionAndWait<SystemContracts.SysioEpochSetconfigAction>(
    "sysio.epoch",
    "setconfig",
    {
      epoch_duration_sec: cfg.epochDurationSec,
      operators_per_epoch: opsPerEpoch,
      batch_operator_minimum_active: adjustedMin,
      batch_op_groups: batchOpGroups,
      epoch_retention_envelope_log_count:
        ClusterManager.EnvelopeLogRetentionEpochs
    },
    "sysio.epoch@active"
  )
  log.info("[Phase 15] sysio.epoch configured")

  // ── Phase 15a: Configure sysio.opreg ──
  log.info("[Phase 15a] Configuring sysio.opreg...")
  // Map ClusterConfig.ChainMinBond[] → action-shape: the depot stamps
  // `config_timestamp_ms` itself, so callers pin it to 0 here.
  // ChainMinBond now keys by (chain_code, token_code) — codenames packed
  // into the nested `{ value: uint64 }` shape the regenerated ABI types
  // emit. The harness-local input still carries plain numbers; this
  // helper wraps them at the action boundary.
  const toChainMinBondRows = (
    rows: { chainCode: number; tokenCode: number; minBond: number }[] | undefined
  ) =>
    (rows ?? []).map(r => ({
      chain_code: { value: r.chainCode },
      token_code: { value: r.tokenCode },
      min_bond: r.minBond,
      config_timestamp_ms: 0
    }))

  await clio.pushActionAndWait<SystemContracts.SysioOpregSetconfigAction>(
    "sysio.opreg",
    "setconfig",
    {
      max_available_producers: 21,
      max_available_batch_ops: 63,
      max_available_underwriters: 21,
      terminate_prune_delay_ms: 600_000, // 10 min for dev
      // Termination thresholds: defaults match `DEFAULT_TERMINATE_*` on the
      // depot (5 consecutive misses, 5% rate, 24h window). Tests that need
      // to observe termination in their timeout budget override via
      // `ClusterConfig.terminateMaxConsecutiveMisses` etc.
      terminate_max_consecutive_misses: cfg.terminateMaxConsecutiveMisses ?? 5,
      terminate_max_pct_misses_24h: cfg.terminateMaxPctMisses24H ?? 5,
      terminate_window_ms: cfg.terminateWindowMs ?? 24 * 60 * 60 * 1000,
      // Per-role collateral requirements. Bootstrapped operators bypass
      // these; non-bootstrapped operators must satisfy every (chain,
      // token_kind, min_bond) entry in the matching vector before the
      // depot's eligibility predicate flips them to ACTIVE.
      req_prod_collat: toChainMinBondRows(cfg.reqProdCollat),
      req_batchop_collat: toChainMinBondRows(cfg.reqBatchopCollat),
      req_uw_collat: toChainMinBondRows(cfg.reqUwCollat)
    },
    "sysio.opreg@active"
  )
  log.info("[Phase 15a] sysio.opreg configured")

  // ── Phase 15b: Configure sysio.system emissions ──
  // payepoch reads sysio.epoch::epochcfg::epoch_duration_sec for the
  // annual→per-epoch scaling, so emissions setup must come after Phase 15
  // (sysio.epoch::setconfig). All annual values must round to a non-zero
  // per-epoch share at the configured epoch_duration_sec; setemitcfg checks
  // and rejects otherwise.
  //
  // Post-PR-354 schema: no `capital_bps`. The implicit capital reserve is
  // `10000 - compute - capex - governance` (= 3000 with these defaults).
  // It stays in `sysio`'s balance each period and is drained lazily by
  // `sysio.system::fundclaim` when `sysio.dclaim::onreward` fires.
  log.info("[Phase 15b] Configuring sysio.system emissions...")

  // The emissions contract reads sysio's balance in WIRE (9-decimal) — a
  // separate token from the chain's SYS resource token. Create + issue
  // WIRE to sysio before setemitcfg/initt5 so the gate sees a balance and
  // payepoch can transfer. Matches the contract test fixture
  // (`contracts/tests/emissions_tests.cpp`): symbol(9, "WIRE").
  // pushActionAndWait is required: each step here reads state mutated by
  // the previous one (issue reads token from create; initt5 reads emitcfg
  // from setemitcfg), so the prior tx must land in a block before the
  // next is built.
  await clio.pushActionAndWait<{
    issuer: string
    maximum_supply: string
  }>(
    "sysio.token",
    "create",
    {
      issuer: "sysio",
      maximum_supply: "1000000000.000000000 WIRE"
    },
    "sysio.token@active"
  )
  await clio.pushActionAndWait<{ to: string; quantity: string; memo: string }>(
    "sysio.token",
    "issue",
    {
      to: "sysio",
      quantity: "1000000000.000000000 WIRE",
      memo: "initial WIRE for emissions"
    },
    "sysio@active"
  )

  const emissionCfg: EmissionConfig = {
    ...EMISSION_CONFIG_DEFAULTS,
    ...(cfg.emissionConfig ?? {})
  }
  // TODO(sdk-core): replace with `SystemContracts.SysioSystemSetemitcfgAction`
  // once @wireio/sdk-core regenerates types against the post-PR-354 ABI.
  await clio.pushActionAndWait<{ cfg: EmissionConfig }>(
    "sysio",
    "setemitcfg",
    { cfg: emissionCfg },
    "sysio@active"
  )

  // Seed t5_state. The emissions gate (sysio.epoch::check_emissions_ready)
  // returns STATE_UNINITIALIZED until this singleton exists, which would
  // make Phase 21 (msgch::bootstrap → epoch::advance) record a blocklog row
  // and refuse to advance from epoch 0 → 1. initt5 must come AFTER
  // setemitcfg (it reads emitcfg) and BEFORE Phase 21.
  await clio.pushActionAndWait<{ start_time: string }>(
    "sysio",
    "initt5",
    {
      // Use chain head time, not local wall clock, so the start_time matches
      // the chain's clock used by accrueepoch.
      start_time: new Date(
        (await clio.getInfo()).head_block_time + "Z"
      )
        .toISOString()
        .slice(0, 19)
    },
    "sysio@active"
  )

  log.info(
    `[Phase 15b] sysio.system emissions configured ` +
      `(compute=${emissionCfg.compute_bps}bps capex=${emissionCfg.capex_bps}bps ` +
      `gov=${emissionCfg.governance_bps}bps cadence=${emissionCfg.pay_cadence_epochs})`
  )

  // ── Phase 15c: Initialize sysio.dclaim ──
  // Idempotent setconfig (creates `cap_config` singleton with default
  // 180-day claimable window). dclaim::onreward / claim / linkswept all
  // assert the singleton exists.
  log.info("[Phase 15c] Initializing sysio.dclaim...")
  await clio.pushAction<{}>(
    "sysio.dclaim",
    "setconfig",
    {},
    "sysio.dclaim@active"
  )
  log.info("[Phase 15c] sysio.dclaim initialized")

  // ── Phase 16: Register chains on sysio.chains ──
  // Post-v6 the chain registry lives on `sysio.chains` and is keyed by a
  // slug_name primary key (uint64 packed). The depot also has its own
  // self-row at `("WIRE"_c, kind=WIRE, is_depot=true)` — registered first
  // so that downstream contract logic that consults the chain table can
  // unconditionally find WIRE without a special-case fallback.
  log.info("[Phase 16] Registering chains on sysio.chains...")
  await clio.pushActionAndWait<SystemContracts.SysioChainsRegchainAction>(
    "sysio.chains",
    "regchain",
    {
      kind: SystemContracts.SysioChainsChainkind.CHAIN_KIND_WIRE,
      code: { value: SlugName.from("WIRE") },
      external_chain_id: 0,
      name: "Wire (depot)",
      description: "The WIRE depot chain itself"
    },
    "sysio.chains@active"
  )
  await clio.pushActionAndWait<SystemContracts.SysioChainsRegchainAction>(
    "sysio.chains",
    "regchain",
    {
      kind: SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM,
      code: { value: SlugName.from("ETHEREUM") },
      external_chain_id: AnvilManager.DefaultChainId,
      name: "Ethereum (anvil)",
      description: "Local anvil EVM chain (test cluster)"
    },
    "sysio.chains@active"
  )
  await clio.pushActionAndWait<SystemContracts.SysioChainsRegchainAction>(
    "sysio.chains",
    "regchain",
    {
      kind: SystemContracts.SysioChainsChainkind.CHAIN_KIND_SVM,
      code: { value: SlugName.from("SOLANA") },
      external_chain_id: 0,
      name: "Solana (test-validator)",
      description: "Local solana-test-validator (test cluster)"
    },
    "sysio.chains@active"
  )
  log.info("[Phase 16] Chains registered (WIRE + ETH + SOL)")

  // ── Phase 16a: Register tokens on sysio.tokens ──
  // Per the v6 plan §3.16 bootstrap-seed table: WIRE / ETH / SOL native +
  // LIQETH / LIQSOL liquid-staking receipts. NATIVE tokens leave
  // `Token.address` empty per the `ChainToken.is_native ⇒ empty
  // contract_addr` proto rule; LIQ tokens carry their canonical
  // chain-of-origin contract address when available.
  log.info("[Phase 16a] Registering tokens on sysio.tokens...")
  const liqEthAddrHex: string | undefined = (() => {
    try {
      const liqethAddrsFile = Path.join(
        cfg.ethereumPath,
        ".local/deployments/liqeth-addrs.json"
      )
      if (!Fs.existsSync(liqethAddrsFile)) return undefined
      const addrs = JSON.parse(Fs.readFileSync(liqethAddrsFile, "utf-8"))
      return typeof addrs.LiqEthToken === "string"
        ? addrs.LiqEthToken
        : undefined
    } catch {
      return undefined
    }
  })()
  const emptyChainAddr = {
    kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
    address: ""
  }
  const liqEthChainAddr = liqEthAddrHex
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_EVM,
        address: liqEthAddrHex.replace(/^0x/i, "")
      }
    : emptyChainAddr
  // LIQSOL is treated as a regular SPL mock for the test cluster (per
  // `outpost-three-concerns.md` — outpost views LIQ tokens as ordinary
  // SPL custody assets). SOLBootstrap.provisionSplReserves creates a
  // mock SPL mint for LIQSOL and persists it alongside USDC/USDT in
  // `<cluster>/data/sol-mock-mints.json`. Read here for Phase 16
  // registration. Production would instead bind LIQSOL to the canonical
  // liqsol-token mint.
  const solMockMints: Record<string, { mint: string; decimals: number }> = (() => {
    try {
      const persistFile = Path.join(cfg.clusterPath, "data", "sol-mock-mints.json")
      if (!Fs.existsSync(persistFile)) return {}
      const raw = JSON.parse(Fs.readFileSync(persistFile, "utf-8")) as Array<{
        code: number; mint: string; decimals: number
      }>
      const out: Record<string, { mint: string; decimals: number }> = {}
      raw.forEach(e => {
        // Reverse-lookup slug_name code → string name by scanning the
        // SlugName roundtrip on the strings we care about. The persist
        // file stores the numeric `code` for compactness.
        ["USDC", "USDT", "LIQSOL"].forEach(name => {
          if (SlugName.from(name) === e.code) {
            out[name] = { mint: e.mint, decimals: e.decimals }
          }
        })
      })
      return out
    } catch {
      return {}
    }
  })()
  const mockUsdcSolMint    = solMockMints["USDC"]?.mint
  const mockUsdtSolMint    = solMockMints["USDT"]?.mint
  const mockLiqsolSolMint  = solMockMints["LIQSOL"]?.mint

  /**
   * Convert a Solana base58 mint pubkey to the SVM-encoded
   * `ChainToken.contract_addr` hex string the depot expects. The
   * depot stores all chain-side addresses as raw hex of the
   * chain-native byte representation (32 bytes for SVM ed25519
   * pubkeys, 20 bytes for EVM addresses).
   */
  const splMintToHex = (b58: string): string => {
    const buf = Buffer.from(
      // Lightweight base58 decode via @solana/web3.js PublicKey.
      // Keep the dependency surface inline to avoid an explicit
      // bs58 import — PublicKey ships with web3.js which is
      // already a workspace dep.
      new SolanaPublicKey(b58).toBytes()
    )
    return buf.toString("hex")
  }
  const liqSolChainAddr = mockLiqsolSolMint
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_SVM,
        address: splMintToHex(mockLiqsolSolMint)
      }
    : emptyChainAddr

  // Mock USDC/USDT addresses (ERC-20 on ETH, SPL on SOL). All four
  // are deployed/created by the bootstrap pipeline:
  //   - ETH side: `deployLocal.ts` deploys MockUsdc + MockUsdt and
  //     persists addresses in `outpost-addrs.json`.
  //   - SOL side: `SOLBootstrap.provisionSplReserves` creates the SPL
  //     mints and persists them in `sol-mock-mints.json`.
  // Both are read here for Phase 16 token registration.
  const mockUsdcEthAddrHex: string | undefined = (() => {
    try {
      const file = Path.join(cfg.ethereumPath, ".local/deployments/outpost-addrs.json")
      if (!Fs.existsSync(file)) return undefined
      const addrs = JSON.parse(Fs.readFileSync(file, "utf-8"))
      return typeof addrs.MockUsdc === "string" ? addrs.MockUsdc : undefined
    } catch { return undefined }
  })()
  const mockUsdtEthAddrHex: string | undefined = (() => {
    try {
      const file = Path.join(cfg.ethereumPath, ".local/deployments/outpost-addrs.json")
      if (!Fs.existsSync(file)) return undefined
      const addrs = JSON.parse(Fs.readFileSync(file, "utf-8"))
      return typeof addrs.MockUsdt === "string" ? addrs.MockUsdt : undefined
    } catch { return undefined }
  })()
  const usdcEthChainAddr = mockUsdcEthAddrHex
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_EVM,
        address: mockUsdcEthAddrHex.replace(/^0x/i, "")
      }
    : emptyChainAddr
  const usdtEthChainAddr = mockUsdtEthAddrHex
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_EVM,
        address: mockUsdtEthAddrHex.replace(/^0x/i, "")
      }
    : emptyChainAddr
  const usdcSolChainAddr = mockUsdcSolMint
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_SVM,
        address: splMintToHex(mockUsdcSolMint)
      }
    : emptyChainAddr
  const usdtSolChainAddr = mockUsdtSolMint
    ? {
        kind: SystemContracts.SysioTokensChainkind.CHAIN_KIND_SVM,
        address: splMintToHex(mockUsdtSolMint)
      }
    : emptyChainAddr

  const tokenRegs: SystemContracts.SysioTokensRegtokenAction[] = [
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: { value: SlugName.from("WIRE") },
      symbol_name: "Wire",
      description: "WIRE chain native asset",
      precision: 9,
      address: emptyChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: { value: SlugName.from("ETH") },
      symbol_name: "Ether",
      description: "Ethereum native asset",
      // Project rule: every token registers with precision=9 (max).
      // Native ETH at 18-decimal wei would overflow the depot's
      // `swap_quote` cp_output math against a 10B-unit reserve seed;
      // standardising on 9 keeps every constant-product computation
      // in a sane integer range and aligns all four chains' token
      // ledgers under one precision contract.
      precision: 9,
      address: emptyChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_LIQ,
      code: { value: SlugName.from("LIQETH") },
      symbol_name: "Liquid ETH",
      description: "Liquid-staking receipt for ETH",
      // Project rule: every token registers with precision=9 (max).
      precision: 9,
      address: liqEthChainAddr
    }
  ]
  // ERC-20 stablecoins on Ethereum — mock USDC + USDT for the test
  // cluster (mainnet would register the canonical contract
  // addresses via the same shape). Per the v6 "TWO Token rows per
  // cross-chain pair" decision, the SOL-side counterparts get
  // distinct slug_name codes (`USDCSOL` / `USDTSOL`) so the depot's
  // `code` primary key doesn't collide.
  tokenRegs.push(
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_ERC20,
      code: { value: SlugName.from("USDC") },
      symbol_name: "USD Coin",
      description: "USDC stablecoin on Ethereum",
      precision: 9,
      address: usdcEthChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_ERC20,
      code: { value: SlugName.from("USDT") },
      symbol_name: "Tether USD",
      description: "USDT stablecoin on Ethereum",
      precision: 9,
      address: usdtEthChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: { value: SlugName.from("SOL") },
      symbol_name: "Sol",
      description: "Solana native asset",
      precision: 9,
      address: emptyChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_LIQ,
      code: { value: SlugName.from("LIQSOL") },
      symbol_name: "Liquid SOL",
      description: "Liquid-staking receipt for SOL",
      precision: 9,
      address: liqSolChainAddr
    },
    // SPL stablecoins on Solana — mock USDC + USDT mints created
    // by `SOLBootstrap.provisionSplReserves` (distinct codes from
    // the ETH-side rows per the two-row decision).
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_SPL,
      code: { value: SlugName.from("USDCSOL") },
      symbol_name: "USDC (Solana)",
      description: "USDC stablecoin on Solana",
      precision: 9,
      address: usdcSolChainAddr
    },
    {
      kind: SystemContracts.SysioTokensTokenkind.TOKEN_KIND_SPL,
      code: { value: SlugName.from("USDTSOL") },
      symbol_name: "USDT (Solana)",
      description: "USDT stablecoin on Solana",
      precision: 9,
      address: usdtSolChainAddr
    }
  )
  await Bluebird.each(tokenRegs, async tokenReg => {
    await clio.pushActionAndWait<SystemContracts.SysioTokensRegtokenAction>(
      "sysio.tokens",
      "regtoken",
      tokenReg,
      "sysio.tokens@active"
    )
  })
  log.info(`[Phase 16a] Registered ${tokenRegs.length} token(s)`)

  // ── Phase 16b: Register ChainToken bindings on sysio.tokens ──
  // Exactly one is_native binding per Chain. LIQ tokens get a per-chain
  // `contract_addr` (the deployed liqEth contract bytes on EVM, the
  // liqsol mint bytes on SVM); native bindings leave `contract_addr` empty.
  log.info("[Phase 16b] Registering ChainToken bindings on sysio.tokens...")
  const ctokRegs: SystemContracts.SysioTokensRegctokAction[] = [
    // Depot ChainToken bindings carry no precision field — the depot's
    // `Token.precision` is the only precision contract (project rule:
    // 9 for all tokens; see `feedback-token-precision-9-max`). Any
    // chain-native ↔ depot precision conversion (e.g. ETH wei → 9-dec)
    // is an outpost-internal concern, not depot-tracked state.
    {
      chain_code: { value: SlugName.from("WIRE") },
      token_code: { value: SlugName.from("WIRE") },
      contract_addr: "",
      is_native: true
    },
    {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("ETH") },
      contract_addr: "",
      is_native: true
    },
    {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("LIQETH") },
      contract_addr: liqEthAddrHex
        ? liqEthAddrHex.replace(/^0x/i, "")
        : "",
      is_native: false
    }
  ]
  // ERC-20 stablecoin bindings on Ethereum + SPL bindings on Solana.
  ctokRegs.push(
    {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("USDC") },
      contract_addr: mockUsdcEthAddrHex
        ? mockUsdcEthAddrHex.replace(/^0x/i, "")
        : "",
      is_native: false
    },
    {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("USDT") },
      contract_addr: mockUsdtEthAddrHex
        ? mockUsdtEthAddrHex.replace(/^0x/i, "")
        : "",
      is_native: false
    },
    {
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("SOL") },
      contract_addr: "",
      is_native: true
    },
    {
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("LIQSOL") },
      contract_addr: mockLiqsolSolMint
        ? splMintToHex(mockLiqsolSolMint)
        : "",
      is_native: false
    },
    {
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("USDCSOL") },
      contract_addr: mockUsdcSolMint
        ? splMintToHex(mockUsdcSolMint)
        : "",
      is_native: false
    },
    {
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("USDTSOL") },
      contract_addr: mockUsdtSolMint
        ? splMintToHex(mockUsdtSolMint)
        : "",
      is_native: false
    }
  )
  await Bluebird.each(ctokRegs, async ctokReg => {
    await clio.pushActionAndWait<SystemContracts.SysioTokensRegctokAction>(
      "sysio.tokens",
      "regctok",
      ctokReg,
      "sysio.tokens@active"
    )
  })
  log.info(`[Phase 16b] Registered ${ctokRegs.length} ChainToken binding(s)`)

  // ── Phase 16c: Seed default reserves on sysio.reserv ──
  // Per v6 plan §3.16, four PRIMARY reserves are seeded with status=ACTIVE
  // at bootstrap (native + LIQ pairs on each external chain). The
  // initial chain/wire amounts are devnet-sized — large enough to clear
  // the constant-product `swapquote` floor and any reasonable per-leg
  // underwriter capacity test, small enough to keep WIRE-side custody
  // explainable in test ledgers.
  log.info("[Phase 16c] Seeding default reserves on sysio.reserv...")
  const reserveSeedAmount = 10_000_000_000
  const reserveRegs: SystemContracts.SysioReservRegreserveAction[] = [
      {
        chain_code: { value: SlugName.from("ETHEREUM") },
        token_code: { value: SlugName.from("ETH") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "ETHEREUM-ETH/WIRE primary reserve",
        description: "Bootstrap-seeded native ETH ↔ WIRE reserve",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("ETHEREUM") },
        token_code: { value: SlugName.from("LIQETH") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "ETHEREUM-LIQETH/WIRE primary reserve",
        description: "Bootstrap-seeded liqETH ↔ WIRE reserve",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("ETHEREUM") },
        token_code: { value: SlugName.from("USDC") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "ETHEREUM-USDC/WIRE primary reserve",
        description: "Bootstrap-seeded USDC ↔ WIRE reserve (mock ERC-20)",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("ETHEREUM") },
        token_code: { value: SlugName.from("USDT") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "ETHEREUM-USDT/WIRE primary reserve",
        description: "Bootstrap-seeded USDT ↔ WIRE reserve (mock ERC-20)",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("SOLANA") },
        token_code: { value: SlugName.from("SOL") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "SOLANA-SOL/WIRE primary reserve",
        description: "Bootstrap-seeded native SOL ↔ WIRE reserve",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("SOLANA") },
        token_code: { value: SlugName.from("LIQSOL") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "SOLANA-LIQSOL/WIRE primary reserve",
        description: "Bootstrap-seeded liqSOL ↔ WIRE reserve",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("SOLANA") },
        token_code: { value: SlugName.from("USDCSOL") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "SOLANA-USDCSOL/WIRE primary reserve",
        description: "Bootstrap-seeded USDC ↔ WIRE reserve on Solana (mock SPL)",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      },
      {
        chain_code: { value: SlugName.from("SOLANA") },
        token_code: { value: SlugName.from("USDTSOL") },
        reserve_code: { value: SlugName.from("PRIMARY") },
        name: "SOLANA-USDTSOL/WIRE primary reserve",
        description: "Bootstrap-seeded USDT ↔ WIRE reserve on Solana (mock SPL)",
        initial_chain_amount: reserveSeedAmount,
        initial_wire_amount: reserveSeedAmount,
        connector_weight_bps: 5000,
        is_private: false,
        owner: ""
      }
    ]
  await Bluebird.each(reserveRegs, async reserveReg => {
    await clio.pushActionAndWait<SystemContracts.SysioReservRegreserveAction>(
      "sysio.reserv",
      "regreserve",
      reserveReg,
      "sysio.reserv@active"
    )
  })
  log.info(`[Phase 16c] Seeded ${reserveRegs.length} default reserve(s)`)

  // ── Phase 17: Configure sysio.uwrit ──
  log.info("[Phase 17] Configuring sysio.uwrit...")
  await clio.pushActionAndWait<SystemContracts.SysioUwritSetconfigAction>(
    "sysio.uwrit",
    "setconfig",
    {
      // The single source of truth for the WIRE-leg swap fee; the swap flows
      // import the same constant to predict post-fee reserve books.
      fee_bps: WIREClient.WireSwapFeeBps,
      // Collateral locks are a wall-clock challenge window (the contract
      // default is 12h). Dev clusters shorten it to 10 minutes — long
      // enough that flows can assert locks PERSIST after settlement,
      // short enough that lock-expiry behaviour is observable in a run.
      collateral_lock_duration_ms: 600_000,
      // NOTE: #414 (fix/opp-dex-precision-routing) drops these three fields from
      // `sysio.uwrit::setconfig` (the WIRE-leg fee is now split rewards/emissions
      // by the fixed `FEE_REWARD_SHARE_BPS`, not by a configurable winner/uw/op
      // share). clio's ABI serializer ignores extra JSON fields, so sending them
      // against #414 is a harmless no-op. They can only be deleted in lock-step
      // with regenerating sdk-core's `SysioUwritSetconfigAction` from #414's ABI
      // (it still types them as required); that regen lands with the #414 merge.
      fee_split_winner_pct: 50,
      fee_split_other_uw_pct: 25,
      fee_split_batch_op_pct: 25
    },
    "sysio.uwrit@active"
  )
  log.info("[Phase 17] sysio.uwrit configured")

  // ── Phase 18: Register batch operators via sysio.opreg (bootstrapped) ──
  // ── Phase 18: Create operator accounts ──
  log.info("[Phase 18] Creating operator accounts...")
  const allOperatorAccounts = [
    ...batchOpStates.map(bo => bo.operatorAccount!),
    ...underwriterStates.map(uw => uw.operatorAccount!)
  ]

  await Promise.all(
    allOperatorAccounts.map(account =>
      createAccountWithRam(clio, account, DEV_K1_PUBLIC_KEY)
    )
  )

  // Wait for accounts to be finalized before assigning resource policies
  await sleep(ClusterManager.PostAccountCreateSettleMs)

  // Assign resource policies
  await Bluebird.mapSeries(allOperatorAccounts, account =>
    addResourcePolicy(clio, account, BOOTSTRAP_NODE_OWNER)
  )

  log.info(
    `[Phase 18] Created ${allOperatorAccounts.length} operator account(s) with resources`
  )

  // ── Phase 18a: Register operators via sysio.opreg ──
  log.info("[Phase 18a] Registering batch operators...")
  await Bluebird.each(batchOpStates, bo =>
    clio.pushActionAndWait<SystemContracts.SysioOpregRegoperatorAction>(
      "sysio.opreg",
      "regoperator",
      {
        account: bo.operatorAccount!,
        type: SystemContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
        is_bootstrapped: true
      },
      "sysio.opreg@active"
    )
  )
  log.info(`[Phase 18a] Registered ${batchOpStates.length} batch operator(s)`)

  // ── Phase 19: Register underwriters via sysio.opreg ──
  log.info("[Phase 19] Registering underwriters...")
  await Bluebird.each(underwriterStates, uw =>
    clio.pushActionAndWait<SystemContracts.SysioOpregRegoperatorAction>(
      "sysio.opreg",
      "regoperator",
      {
        account: uw.operatorAccount!,
        type: SystemContracts.SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER,
        is_bootstrapped: false
      },
      "sysio.opreg@active"
    )
  )
  log.info(`[Phase 19] Registered ${underwriterStates.length} underwriter(s)`)

  // ── Phase 19a: Link operator chain accounts via authex ──
  // Each operator needs authex links for all active outpost chains so that
  // advance() can include their chain addresses in the OPERATORS attestation.
  log.info("[Phase 19a] Linking operator chain accounts via authex...")
  const anvilMnemonic = ethers.Mnemonic.fromPhrase(
    ETHBootstrapper.AnvilMnemonic
  )

  // Link all operators (batch ops then underwriters) with sequential HD indices.
  // For batch operators we inject the ED25519 key that their node will use to
  // sign Solana transactions — otherwise the SOL outpost would reject
  // epoch_in as coming from a non-active operator.
  const allOperatorStates = [...batchOpStates, ...underwriterStates]
  await Bluebird.mapSeries(
    allOperatorStates.entries(),
    async ([i, nodeState]) => {
      const account = nodeState.operatorAccount!
      // Batch ops have keys in `batchOpSolKeys`; underwriters in
      // `uwSolKeys` (the keys are kept on separate maps so that each
      // operator-type cohort is generated from a single site and the
      // Phase 19b deposit can lift the underwriter key without
      // string-matching against `account.startsWith("uwrit.")`).
      const solKey = batchOpSolKeys[account] ?? uwSolKeys[account]
      await linkOperatorChainAccounts(
        clio,
        anvilMnemonic,
        account,
        i + 1,
        solKey,
        false
      )
      log.info(`[Phase 19a] Linked ETH+SOL keys for ${account}`)
    }
  )

  log.info("[Phase 19a] All authex links created")

  // ── Phase 20: Initialize batch operator groups ──
  log.info("[Phase 20] Initializing epoch state...")

  // No activation needed — bootstrapped batch ops are already AVAILABLE
  // schbatchgps reads AVAILABLE batch ops from sysio.opreg
  await clio.pushActionAndWait<SystemContracts.SysioEpochSchbatchgpsAction>(
    "sysio.epoch",
    "schbatchgps",
    {},
    "sysio.epoch@active"
  )
  log.info("[Phase 20] Batch operator groups initialized")

  // ── Phase 21: Bootstrap first epoch (epoch 0 → 1) ──
  log.info("[Phase 21] Bootstrapping first epoch...")
  await clio.pushActionAndWait<SystemContracts.SysioMsgchBootstrapAction>(
    "sysio.msgch",
    "bootstrap",
    {},
    "sysio.msgch@active"
  )
  log.info("[Phase 21] First epoch bootstrapped (epoch_index=1)")

  log.info("=== Bootstrap sequence complete ===")
}

export namespace ClusterManager {
  // ── Node directory prefixes ──

  /** Directory name for the bios node. */
  export const BiosNodePath = "node_bios"

  /** Prefix for producer node directories (e.g. node_00, node_01). */
  export const ProducerNodePrefix = "node_"

  /** Prefix for batch operator node directories (e.g. node_batchop_00). */
  export const BatchOpNodePrefix = "node_batchop_"

  /** Prefix for underwriter node directories (e.g. node_uwrit_00). */
  export const UnderwriterNodePrefix = "node_uwrit_"

  /** Zero-pad an index to 2 digits (e.g. 0 → "00", 7 → "07"). */
  export function padIndex(i: number): string {
    return String(i).padStart(2, "0")
  }

  /** Producer node directory name for a given index. */
  export function toProducerNodePath(i: number): string {
    return `${ProducerNodePrefix}${padIndex(i)}`
  }

  /** Batch operator node directory name for a given index. */
  export function toBatchOpNodePath(i: number): string {
    return `${BatchOpNodePrefix}${padIndex(i)}`
  }

  /** Underwriter node directory name for a given index. */
  export function toUnderwriterNodePath(i: number): string {
    return `${UnderwriterNodePrefix}${padIndex(i)}`
  }

  // ── Timeouts & ports ──

  /** Fallback clio URL (used during wallet setup before nodes are up). */
  export const ClioFallbackUrl = toURL(BIOS_HTTP_PORT)

  /** Timeout for waiting on a node endpoint (ms). */
  export const NodeStartupTimeoutMs = 30_000

  /** Timeout for producer handoff after setprodkeys (ms). */
  export const HandoffTimeoutMs = 90_000

  /** Delay between staggered node starts (ms). */
  export const NodeStartDelayMs = 2_000

  /** Delay after node shutdown before proceeding (ms). */
  export const ShutdownDelayMs = 2_000

  /**
   * How often batch operators poll the chain for new epochs. Setting this
   * too high delays epoch promotion; too low increases nodeop load on a
   * single-producer test cluster.
   */
  export const BatchEpochPollMs = 15_000

  /**
   * Per-epoch delivery deadline for batch operators. Tx submission beyond
   * this window is treated as failed — the next epoch takes over.
   */
  export const BatchDeliveryTimeoutMs = 15_000

  /** Timeout for nodeop sync verification via verifyCallback (ms). */
  export const NodeSyncTimeoutMs = 300_000

  /** Poll interval for nodeop sync verification (ms). */
  export const NodeSyncPollIntervalMs = 5_000

  // ── Anvil / Solana subdirectories ──

  /** Subdirectory under clusterPath that holds chain data (per-node + outposts). */
  export const DataSubpath = "data"

  /** Subdirectory under clusterPath that holds wallet keys (kiod vault + kiod logs). */
  export const WalletSubpath = "wallet"

  /** Anvil state subdirectory within clusterPath/data. */
  export const AnvilStateSubpath = "anvil/state"

  /** Solana validator ledger subdirectory within clusterPath/data. */
  export const SolanaLedgerSubpath = "solana_validator"

  /** OPP debugging storage subdirectory within clusterPath/data. */
  export const OPPDebuggingSubpath = "opp-debugging"

  /** Finalizer state subdirectory within a node's data dir. */
  export const FinalizersSubpath = "finalizers"

  /**
   * FSI lock file written by the finalizer. Deleted on relaunch so a stale
   * lock from a pruned fork can't stall the restart vote loop.
   */
  export const SafetyDatFile = "safety.dat"

  /**
   * Standard retry policy for `clio` contract / account operations. The
   * WIRE producer regularly drops transient errors during block production;
   * three attempts smooth those out without masking a real failure.
   */
  export const ClioRetryAttempts = 3

  /** Delay between {@link ClioRetryAttempts} retries when the op is heavy. */
  export const ClioRetryHeavyDelayMs = 2_000

  /** Delay between {@link ClioRetryAttempts} retries when the op is light. */
  export const ClioRetryLightDelayMs = 1_000

  /** Poll interval between `get_info` checks during producer handoff. */
  export const HandoffPollIntervalMs = 1_000

  /** Timeout applied to `fetch` calls made during node-readiness polling. */
  export const NodeReadinessFetchTimeoutMs = 3_000

  /**
   * Pre-resume settle delay — gives every producer node a couple of seconds
   * to register their finalizer state before {@link force_unpause} fires.
   */
  export const PreResumeSettleMs = 2_000

  /**
   * Settle delay after batch creating system accounts before applying
   * resource policies on each one.
   */
  export const PostAccountCreateSettleMs = 1_000

  /**
   * Cap multiplier for the metadata-only `envelope_log` table on
   * `sysio.msgch`. Effective row cap is
   * `active_outposts * 2 * EnvelopeLogRetentionEpochs`. Default 128 —
   * matches `MAX_TRACKED_ENVELOPES` on the Solana opp-outpost program
   * so the on-chain audit window is symmetric across chains.
   */
  export const EnvelopeLogRetentionEpochs = 128

  /** Initial token supply for `sysio.token.create`. */
  export const InitialTokenSupply = "1000000000.0000 SYS"

  /** Per-producer token grant issued during bootstrap. */
  export const ProducerInitialGrant = "1000000.0000 SYS"

  /**
   * Resolve all executable paths from a build directory.
   * Wire binaries (nodeop, kiod, clio, sys-util) come from buildPath/bin/.
   * External chain binaries (anvil, solana-test-validator) are resolved via PATH.
   */
  export async function resolveExePaths(
    buildPath: string
  ): Promise<ClusterExePaths> {
    const toBin = (name: string) => Path.join(buildPath, "bin", name),
      exePaths: ClusterExePaths = asOption({
        nodeop: toBin("nodeop"),
        kiod: toBin("kiod"),
        clio: toBin("clio"),
        sysUtil: toBin("sys-util"),
        anvil: await which("anvil"),
        solanaTestValidator: await which("solana-test-validator")
      })
        .tap(exePaths =>
          Object.entries(exePaths).forEach(([name, path]) =>
            Assert.ok(
              path && Fs.existsSync(path),
              `${name} binary not found at ${path}`
            )
          )
        )
        .get()

    return exePaths
  }

  /**
   * Convenience factory for tests and scripts — resolves ports + exe paths,
   * assembles a full ClusterConfig, runs create(), and returns the manager.
   */
  export async function createFromCLIArgs(
    opts: ClusterOptions
  ): Promise<ClusterManager> {
    const {
      buildPath,
      clusterPath,
      ethereumPath,
      solanaPath,
      producerCount = 21,
      nodeCount = 1,
      batchOperatorCount = 3,
      underwriterCount = 1,
      epochDurationSec = 360,
      warmupEpochs = 1,
      cooldownEpochs = 1,
      terminateMaxConsecutiveMisses,
      terminateMaxPctMisses24H,
      terminateWindowMs,
      reqProdCollat,
      reqBatchopCollat,
      reqUwCollat,
      underwriterCollateral,
      emissionConfig,
      force = false
    } = opts

    if (force && Fs.existsSync(clusterPath)) {
      Fs.rmSync(clusterPath, { recursive: true, force: true })
    }
    mkdirs(clusterPath)

    ProcessManager.setClusterPath(clusterPath)

    const config: ClusterConfig = {
      buildPath,
      clusterPath,
      dataPath: mkdirs(Path.join(clusterPath, ClusterManager.DataSubpath)),
      walletPath: mkdirs(Path.join(clusterPath, ClusterManager.WalletSubpath)),
      producerCount,
      nodeCount,
      httpSecure: false,
      batchOperatorCount,
      underwriterCount,
      ethereumPath,
      solanaPath,
      epochDurationSec,
      warmupEpochs,
      cooldownEpochs,
      terminateMaxConsecutiveMisses,
      terminateMaxPctMisses24H,
      terminateWindowMs,
      reqProdCollat,
      reqBatchopCollat,
      reqUwCollat,
      underwriterCollateral:
        underwriterCollateral ??
        UnderwriterTools.Collateral.load(undefined, underwriterCount),
      emissionConfig,
      ports: await ClusterPorts.resolve({
        nodeCount,
        batchOperatorCount,
        underwriterCount
      }),
      executables: await resolveExePaths(buildPath)
    }

    writeClusterConfigFile(
      Path.join(clusterPath, ClusterFiles.ConfigFilename),
      config
    )

    const manager = new ClusterManager(config)
    await manager.create()
    return manager
  }
}
