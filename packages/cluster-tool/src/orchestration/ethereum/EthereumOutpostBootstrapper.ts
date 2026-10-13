import { execFile } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { promisify } from "node:util"
import { ethers } from "ethers"
import { defaults, range } from "lodash"
import Assert from "node:assert"
import { ChainKind } from "@wireio/opp-typescript-models"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { Constants } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import {
  LongFileLockOptions,
  mkdirs,
  withFileLock
} from "../../utils/fsUtils.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"
import {
  EvmAddressPattern,
  loadOutpostContract
} from "../../utils/ethereumUtils.js"

const log = getLogger(__filename)
const execFileAsync = promisify(execFile)

/** One deterministic anvil account, annotated with its bootstrap usage. */
export interface EthereumAccount {
  address: string
  privateKey: string
  publicKey: string
  usedInBootstrap: boolean
  usedFor: string
}

/**
 * A batch-operator roster for `OPPInbound` — what `initialize` installs at
 * construction (WNE-41) and what `installInitialRoster` replaces it with once
 * the depot's schedule exists (SOL-376 shape, see
 * {@link EthereumOutpostBootstrapper.oppBootstrap}).
 *
 * `OPPInbound.isActiveOperator` is FAIL-CLOSED: an uninitialized roster
 * authorizes nobody, and on a WIRE cluster the addresses that send `epochIn`
 * are the batch-operator DAEMONS' own EOAs — not the deployer. Without this the
 * first envelope is refused and the epoch never advances.
 */
export interface EthereumOutpostInitialRoster {
  /**
   * Batch-operator ETH addresses, one group per depot window slot in slot
   * order: `groups[k]` serves epoch `1 + k` and its length is that epoch's
   * consensus threshold (WNE-27). The construction-time roster can only
   * reproduce the depot's SHAPE; the seeded one IS the depot's window.
   */
  groups: string[][]
  /** The depot's global `epoch_duration_sec`; must be positive. */
  epochDurationSec: number
}

/** Caller options for {@link EthereumOutpostBootstrapper}. */
export interface EthereumOutpostBootstrapperOptions {
  /** Path to the `wire-ethereum` repo root. */
  ethereumPath: string
  /** Cluster data path for the annotated accounts file. */
  anvilDataPath: string
  /** RPC URL of the already-running run anvil to deploy against. */
  rpcUrl: string
  /**
   * THIS cluster's deploy-artifact dir (`ClusterConfigProvider.ethereumDeploymentsPath`)
   * — deploy configs + address files land here, and `deployLocal.ts` is pointed
   * at it via `WIRE_ETH_DEPLOYMENTS_PATH`. Per-cluster so parallel flows never
   * clobber each other's deploy state (2026-07-02 pair-1 incident: two deploys
   * sharing `<wire-ethereum>/.local/deployments/` wiped each other mid-run).
   */
  deploymentsPath: string
  /**
   * WNE-41 initial batch-operator roster for `OPPInbound.initialize`. Required:
   * a cluster deployed without one has an outpost whose `epochIn` is callable
   * by nobody, and `initialize` is one-shot.
   */
  initialRoster: EthereumOutpostInitialRoster
  /**
   * Number of deterministic accounts to generate — MUST match the run anvil's
   * `--accounts` (default: {@link AnvilProcess.AccountCount}) so every generated
   * account maps to a pre-funded anvil account.
   */
  accountCount?: number
}

/** Resolved {@link EthereumOutpostBootstrapper} config. */
export interface EthereumOutpostBootstrapperConfig extends Required<EthereumOutpostBootstrapperOptions> {}

/**
 * Bootstrap the Ethereum (anvil) outpost for the test cluster: generate
 * deterministic accounts from anvil's default mnemonic, deploy the
 * `wire-ethereum` contracts via Hardhat AGAINST the already-running run anvil,
 * and write an annotated
 * accounts file.
 *
 * The run anvil is started separately (`Steps.processes.anvil.start`) and owned
 * by the process manager for the whole cluster lifecycle — this bootstrapper
 * never spawns its own anvil; it only deploys against the one it is handed.
 *
 */
export class EthereumOutpostBootstrapper {
  private readonly config: EthereumOutpostBootstrapperConfig
  private accounts: EthereumAccount[] = []

  constructor(options: EthereumOutpostBootstrapperOptions) {
    Assert.ok(
      options.ethereumPath,
      "EthereumOutpostBootstrapper: ethereumPath is required"
    )
    Assert.ok(
      options.anvilDataPath,
      "EthereumOutpostBootstrapper: anvilDataPath is required"
    )
    Assert.ok(options.rpcUrl, "EthereumOutpostBootstrapper: rpcUrl is required")
    Assert.ok(
      options.deploymentsPath,
      "EthereumOutpostBootstrapper: deploymentsPath is required"
    )
    // WNE-41 — fail HERE, before anvil is touched. An empty or zero-duration
    // roster is refused by `OPPInbound` itself (`OPP_InvalidInitialRoster`),
    // and at construction that revert surfaces as a failed deploy mid-run.
    Assert.ok(
      options.initialRoster?.groups?.some(group => group.length > 0),
      "EthereumOutpostBootstrapper: initialRoster needs at least one batch-operator address"
    )
    Assert.ok(
      options.initialRoster.epochDurationSec > 0,
      "EthereumOutpostBootstrapper: initialRoster.epochDurationSec must be positive"
    )
    this.config = defaults(
      { ...options },
      EthereumOutpostBootstrapper.createDefaultOptions()
    ) as EthereumOutpostBootstrapperConfig
  }

  /**
   * Run the full Ethereum-outpost bootstrap: generate accounts → deploy
   * contracts against the running anvil → write the
   * annotated accounts file. The anvil is neither started nor stopped here —
   * it is the process-manager-owned run anvil for the whole cluster lifecycle.
   */
  async bootstrap(): Promise<EthereumAccount[]> {
    const { ethereumPath, anvilDataPath, rpcUrl, accountCount } = this.config

    log.info(
      `[ethereum] generating ${accountCount} accounts, deploying against ${rpcUrl}`
    )
    this.accounts = EthereumOutpostBootstrapper.generateAccounts(accountCount)

    await this.deployContracts(ethereumPath, rpcUrl)
    this.writeAccounts(anvilDataPath)
    return this.accounts
  }

  /**
   * The ladder instead of the fresh deploy: generate accounts, run
   * wire-ethereum's `deployLadder.ts` against the run anvil — the liqEth and
   * outpost ladders as mainnet climbed them, stopping before the go-live
   * freeze — and write the annotated accounts file. What it leaves is the
   * PRE-LAUNCH outpost; {@link deepFreeze} and {@link goLive} take it live.
   */
  async ladder(): Promise<EthereumAccount[]> {
    const { anvilDataPath, rpcUrl, accountCount, deploymentsPath } = this.config
    log.info(
      `[ethereum] generating ${accountCount} accounts, climbing the ladder against ${rpcUrl}`
    )
    this.accounts = EthereumOutpostBootstrapper.generateAccounts(accountCount)
    const localDir = mkdirs(deploymentsPath)
    this.markAccountUsed(
      EthereumOutpostBootstrapper.DeployerAccountIndex,
      "Ladder deploy owner (liqEth + outpost, mainnet order)"
    )
    Fs.writeFileSync(
      Path.join(localDir, EthereumOutpostBootstrapper.LadderConfigFile),
      JSON.stringify(
        EthereumOutpostBootstrapper.ladderConfig(this.panicAccount()),
        null,
        2
      )
    )
    await this.runHardhatScript(
      EthereumOutpostBootstrapper.LadderScript,
      localDir,
      {},
      "ladder"
    )
    this.recordArtifacts(localDir, [
      ...EthereumOutpostBootstrapper.StaleDeployArtifactFiles,
      EthereumOutpostBootstrapper.LadderSummaryFile
    ])
    this.writeAccounts(anvilDataPath)
    return this.accounts
  }

  /**
   * Go-live step 0 on the ladder's outpost: the deep freeze, as the real
   * `UPGRADE_CONFIG` script, which records the booked figure
   * (`Depositor.lastPoolLiqBalance`) into the release state.
   */
  async deepFreeze(): Promise<void> {
    const { rpcUrl, accountCount, deploymentsPath } = this.config
    this.accounts = EthereumOutpostBootstrapper.generateAccounts(accountCount)
    const localDir = mkdirs(deploymentsPath),
      configFile = Path.join(
        localDir,
        EthereumOutpostBootstrapper.DeepFreezeConfigFile
      )
    Fs.writeFileSync(
      configFile,
      JSON.stringify(
        EthereumOutpostBootstrapper.deepFreezeConfig(
          rpcUrl,
          this.deployerPrivateKey(),
          localDir
        ),
        null,
        2
      )
    )
    await this.runHardhatScript(
      EthereumOutpostBootstrapper.DeepFreezeScript,
      localDir,
      { UPGRADE_CONFIG: configFile },
      "deep-freeze"
    )
    this.recordArtifacts(localDir, [
      EthereumOutpostBootstrapper.OutpostReleaseStateFile
    ])
  }

  /**
   * Go-live step 1 on the frozen outpost: the pool upgraded in place and
   * seeded from the booked figure, the OPP pair and BAR fresh under the
   * go-live salt with the provisional batch-operator roster, everything
   * re-wired — as the real `UPGRADE_CONFIG` script.
   *
   * @param wireNodes - The WireNodes ERC-1155 BAR draws claims from (the ladder's stand-in).
   */
  async goLive(wireNodes: string): Promise<void> {
    const { rpcUrl, accountCount, deploymentsPath, initialRoster } = this.config
    this.accounts = EthereumOutpostBootstrapper.generateAccounts(accountCount)
    const localDir = mkdirs(deploymentsPath),
      configFile = Path.join(
        localDir,
        EthereumOutpostBootstrapper.GoLiveConfigFile
      )
    log.info(
      `[ethereum] go-live roster: ${initialRoster.groups
        .map(group => `[${group.join(", ")}]`)
        .join(" ")} (epochDurationSec=${initialRoster.epochDurationSec})`
    )
    Fs.writeFileSync(
      configFile,
      JSON.stringify(
        EthereumOutpostBootstrapper.goLiveConfig(
          rpcUrl,
          this.deployerPrivateKey(),
          localDir,
          this.panicAccount(),
          initialRoster,
          wireNodes
        ),
        null,
        2
      )
    )
    await this.runHardhatScript(
      EthereumOutpostBootstrapper.GoLiveScript,
      localDir,
      { UPGRADE_CONFIG: configFile },
      "go-live"
    )
    this.recordArtifacts(localDir, [
      EthereumOutpostBootstrapper.OutpostAddressesFile,
      EthereumOutpostBootstrapper.OutpostReleaseStateFile
    ])
  }

  /** The deployer (anvil HD index 0) key; the generated accounts must exist. */
  private deployerPrivateKey(): string {
    Assert.ok(
      this.accounts.length > EthereumOutpostBootstrapper.DeployerAccountIndex,
      "EthereumOutpostBootstrapper: accounts are not generated"
    )
    return this.accounts[EthereumOutpostBootstrapper.DeployerAccountIndex]
      .privateKey
  }

  /** The panic account's address (anvil HD index 49), marked used. */
  private panicAccount(): string {
    Assert.ok(
      this.accounts.length > EthereumOutpostBootstrapper.PanicAccountIndex,
      `EthereumOutpostBootstrapper: ${this.accounts.length} generated accounts leave no HD index ` +
        `${EthereumOutpostBootstrapper.PanicAccountIndex} for the panic account`
    )
    this.markAccountUsed(
      EthereumOutpostBootstrapper.PanicAccountIndex,
      "Emergency-stop panic account (panic role: pause / unpause)"
    )
    return this.accounts[EthereumOutpostBootstrapper.PanicAccountIndex].address
  }

  /** Write the annotated accounts file under the anvil data dir. */
  private writeAccounts(anvilDataPath: string): void {
    const accountsFile = Path.join(
      mkdirs(anvilDataPath),
      EthereumOutpostBootstrapper.AccountsFile
    )
    Fs.writeFileSync(accountsFile, JSON.stringify(this.accounts, null, 2))
    log.info(
      `[ethereum] wrote ${this.accounts.length} accounts to ${accountsFile}`
    )
  }

  /**
   * Run one wire-ethereum hardhat script against the run anvil, serialized
   * host-wide: hardhat compiles into the SHARED repo cache/artifacts on demand,
   * and two concurrent compiles corrupt them. The per-run state (configs +
   * address files) is isolated via `deploymentsPath`; hardhat's `localhost`
   * network is pointed at this cluster's anvil through `LOCALHOST_RPC_URL`.
   *
   * @param script - The script path, relative to the wire-ethereum root.
   * @param localDir - This cluster's deployments dir (`WIRE_ETH_DEPLOYMENTS_PATH`).
   * @param extraEnv - Script-specific environment (an `UPGRADE_CONFIG`, say).
   * @param label - The log label.
   */
  private async runHardhatScript(
    script: string,
    localDir: string,
    extraEnv: Record<string, string>,
    label: string
  ): Promise<void> {
    const { ethereumPath, rpcUrl } = this.config,
      args = [
        "hardhat",
        "run",
        script,
        "--network",
        EthereumOutpostBootstrapper.HardhatLocalhostNetwork
      ]
    log.info(`[ethereum] running ${script} via hardhat (${label})...`)
    StepExtraRecorder.record({
      client: "process",
      kind: "exec",
      command: ["npx", ...args],
      cwd: ethereumPath
    })
    const { stdout, stderr } = await withFileLock(
      EthereumOutpostBootstrapper.HardhatDeployLockPath,
      () =>
        execFileAsync("npx", args, {
          cwd: ethereumPath,
          timeout: scaleTimeoutMs(
            EthereumOutpostBootstrapper.HardhatDeployTimeoutMs
          ),
          maxBuffer: EthereumOutpostBootstrapper.HardhatDeployBufferBytes,
          env: {
            ...process.env,
            HARDHAT_NETWORK: EthereumOutpostBootstrapper.HardhatLocalhostNetwork,
            LOCALHOST_RPC_URL: rpcUrl,
            WIRE_ETH_DEPLOYMENTS_PATH: localDir,
            ...extraEnv
          }
        }),
      LongFileLockOptions
    )
    if (stderr)
      log.debug(
        `[ethereum] hardhat stderr (${label}):\n${stderr.slice(0, EthereumOutpostBootstrapper.HardhatStderrTailChars)}`
      )
    log.info(
      `[ethereum] ${label} output:\n${stdout.slice(-EthereumOutpostBootstrapper.HardhatStdoutTailChars)}`
    )
  }

  /**
   * Land each present, non-empty artifact file in the step extra — the
   * script's OUTPUT (the address books, the release state, the summary) is
   * the step's payload.
   */
  private recordArtifacts(localDir: string, names: readonly string[]): void {
    names.forEach(name => {
      const file = Path.join(localDir, name)
      if (!Fs.existsSync(file)) return
      const contents = Fs.readFileSync(file, "utf-8")
      if (contents.trim().length === 0) return
      log.info(`[ethereum] ${name}: ${contents}`)
      StepExtraRecorder.record({
        client: "harness",
        kind: "artifact",
        file: name,
        contents: JSON.parse(contents) as Record<string, unknown>
      })
    })
  }

  /** Mark an account as used during bootstrap (for the annotated accounts file). */
  private markAccountUsed(index: number, usedFor: string): void {
    const account = this.accounts[index]
    if (account != null) {
      account.usedInBootstrap = true
      account.usedFor = usedFor
    }
  }

  /**
   * Deploy the `wire-ethereum` contracts by invoking Hardhat's `deployLocal.ts`.
   * Writes deploy configs (pointing at the running anvil, deployer = account 0)
   * into THIS cluster's `deploymentsPath` — `deployLocal.ts` reads/writes the
   * same dir via `WIRE_ETH_DEPLOYMENTS_PATH` — clearing any stale address files
   * first so a previous anvil's addresses can't be picked up by mistake. The
   * hardhat invocation itself is serialized host-wide: parallel runs share the
   * repo's compile cache/artifacts, and concurrent compiles corrupt them.
   */
  private async deployContracts(
    ethereumPath: string,
    rpcUrl: string
  ): Promise<void> {
    log.info(`[ethereum] deploying contracts from ${ethereumPath}`)
    const deployerPrivateKey =
      this.accounts[EthereumOutpostBootstrapper.DeployerAccountIndex].privateKey
    this.markAccountUsed(
      EthereumOutpostBootstrapper.DeployerAccountIndex,
      "Contract deployer (LiqEth + Outpost)"
    )

    const localDir = this.config.deploymentsPath
    mkdirs(localDir)
    EthereumOutpostBootstrapper.StaleDeployArtifactFiles.forEach(name => {
      const file = Path.join(localDir, name)
      if (Fs.existsSync(file)) Fs.unlinkSync(file)
    })

    const panicAccount = this.panicAccount()
    const { initialRoster } = this.config,
      liqEthConfig = EthereumOutpostBootstrapper.liqEthDeployConfig(
        rpcUrl,
        deployerPrivateKey,
        localDir,
        panicAccount
      ),
      outpostConfig = EthereumOutpostBootstrapper.outpostDeployConfig(
        rpcUrl,
        deployerPrivateKey,
        localDir,
        panicAccount,
        initialRoster
      )
    log.info(
      `[ethereum] initial batch-operator roster: ${initialRoster.groups
        .map(group => `[${group.join(", ")}]`)
        .join(" ")} (epochDurationSec=${initialRoster.epochDurationSec})`
    )
    Fs.writeFileSync(
      Path.join(localDir, "liqeth.json"),
      JSON.stringify(liqEthConfig, null, 2)
    )
    Fs.writeFileSync(
      Path.join(localDir, "outpost.json"),
      JSON.stringify(outpostConfig, null, 2)
    )

    await this.runHardhatScript(
      EthereumOutpostBootstrapper.DeployLocalScript,
      localDir,
      {},
      "deploy"
    )
    this.recordArtifacts(
      localDir,
      EthereumOutpostBootstrapper.StaleDeployArtifactFiles
    )
    log.info("[ethereum] contract deployment complete")
  }

  /**
   * Seed the ETH outpost's batch-operator roster from the depot's REAL schedule
   * via `OPPInbound.installInitialRoster` — the SOL-376 `opp_bootstrap` shape.
   *
   * `initialize` ran in Cluster Prerequisites, before `sysio.epoch::schbatchgps`
   * existed, so the roster it seated could only reproduce the depot's shape,
   * not its membership; under WNE-27 epoch 1 is deliverable solely by the
   * group mapped to it, so that provisional roster leaves the outpost
   * undeliverable whenever the depot's name-ordered schedule seats a different
   * operator. This call must therefore land AFTER `schbatchgps` and BEFORE the
   * depot's first envelope — `installInitialRoster` refuses once an epoch-1
   * delivery has been counted (`OPP_BootstrapWindowClosed`). The seed is
   * transient: the depot's first `BATCH_OPERATOR_GROUPS` attestation replaces
   * it under consensus.
   *
   * Routed through `OutpostManager.execute` as the deployer (anvil HD index 0,
   * the manager's post-handoff admin), exactly like `deployLocal.ts` wires the
   * other `restricted` setters. Every window slot is installed, so slot `k`
   * serves epoch `1 + k` as a delivered window would.
   *
   * @param seed - the depot's window as EVM addresses + the slot serving epoch 1.
   */
  async oppBootstrap(
    seed: EthereumOutpostBootstrapper.OppBootstrapSeed
  ): Promise<void> {
    const { ethereumPath, deploymentsPath, rpcUrl } = this.config,
      initialGroups =
        EthereumOutpostBootstrapper.initialBatchOperatorGroups(seed),
      outpostAddressesFile = Path.join(
        deploymentsPath,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      )
    Assert.ok(
      Fs.existsSync(outpostAddressesFile),
      `oppBootstrap: ${outpostAddressesFile} is missing — the Ethereum outpost deploy must precede the roster seed`
    )
    const outpostAddresses: Record<string, string> = JSON.parse(
        Fs.readFileSync(outpostAddressesFile, "utf-8")
      ),
      provider = new ethers.JsonRpcProvider(rpcUrl),
      // The deployer is `deployLocal.ts`'s `owner`: the OutpostManager admin
      // after handoff, and the ONE signer allowed through `manager.execute`.
      deployer = new ethers.Wallet(
        EthereumOutpostBootstrapper.generateAccounts(
          EthereumOutpostBootstrapper.DeployerAccountIndex + 1
        )[EthereumOutpostBootstrapper.DeployerAccountIndex].privateKey,
        provider
      ),
      manager =
        loadOutpostContract<EthereumOutpostBootstrapper.OutpostManagerExecuteView>(
          ethereumPath,
          outpostAddresses,
          EthereumOutpostBootstrapper.OutpostManagerContractName,
          [...EthereumOutpostBootstrapper.OutpostArtifactSubpath],
          deployer,
          EthereumOutpostBootstrapper.OutpostManagerContractName,
          EthereumOutpostBootstrapper.OutpostManagerArtifactName
        ),
      oppInbound =
        loadOutpostContract<EthereumOutpostBootstrapper.OppInboundRosterView>(
          ethereumPath,
          outpostAddresses,
          EthereumOutpostBootstrapper.OppInboundContractName,
          [...EthereumOutpostBootstrapper.OutpostArtifactSubpath],
          deployer
        ),
      oppInboundAddress = await oppInbound.getAddress(),
      activeGroup = seed.window.groups[seed.activeGroupIndex]

    log.info(
      `[ethereum] installInitialRoster: seeding ${seed.window.groups.length} window slot(s), ` +
        `epoch-1 slot ${seed.activeGroupIndex} = [${activeGroup.join(", ")}], ` +
        `epoch_duration=${seed.window.epochDurationSec}s (deployer=${deployer.address})`
    )
    try {
      const transaction = await manager.execute(
        oppInboundAddress,
        oppInbound.interface.encodeFunctionData(
          EthereumOutpostBootstrapper.InstallInitialRosterFunction,
          [initialGroups]
        )
      )
      await transaction.wait()

      // Read the seat back: the outpost must now authorize the depot's epoch-1
      // operators and nobody from the provisional roster it replaced.
      const seated = await Promise.all(
        activeGroup.map(member => oppInbound.isActiveOperator(member))
      )
      Assert.ok(
        seated.every(Boolean),
        `oppBootstrap: OPPInbound does not authorize every epoch-1 member after installInitialRoster ` +
          `([${activeGroup.join(", ")}] → [${seated.join(", ")}])`
      )
    } finally {
      provider.destroy()
    }
    log.info(
      "[ethereum] installInitialRoster: ETH outpost roster seeded on the depot's schedule"
    )
  }
}

export namespace EthereumOutpostBootstrapper {
  /**
   * SOL-376 seed for `OPPInbound.installInitialRoster`: the depot's whole
   * schedule window as EVM addresses plus the slot the depot serves epoch 1
   * from (`epochstate.current_batch_op_group`).
   */
  export interface OppBootstrapSeed {
    /** Every window group in slot order, with the depot's epoch duration. */
    window: EthereumOutpostInitialRoster
    /** Index of the window group that serves epoch 1. */
    activeGroupIndex: number
  }

  /** One `ChainAddress` as `OPPInbound.installInitialRoster` takes it. */
  export interface InitialChainAddress {
    kind: ChainKind
    address_: string
  }

  /** One `BatchOperatorGroup` of the roster tuple. */
  export interface InitialBatchOperatorGroup {
    operators: InitialChainAddress[]
  }

  /** The `BatchOperatorGroups` tuple `OPPInbound.installInitialRoster` takes. */
  export interface InitialBatchOperatorGroups {
    activeGroupIndex: number
    epochIndex: number
    groups: InitialBatchOperatorGroup[]
    epochDurationSec: number
  }

  /** The `OutpostManager` surface the seed drives — the post-handoff admin path. */
  export interface OutpostManagerExecuteView {
    execute(
      target: string,
      data: string
    ): Promise<ethers.ContractTransactionResponse>
  }

  /** The `OPPInbound` surface the seed reads back through. */
  export interface OppInboundRosterView {
    isActiveOperator(operator: string): Promise<boolean>
  }

  /** `deployLocal.ts`'s outpost address map, under the cluster's deployments dir. */
  export const OutpostAddressesFile = "outpost-addrs.json"
  /** Artifact dir segments under `<wire-ethereum>/artifacts/contracts` for the OPP contracts. */
  export const OutpostArtifactSubpath = ["outpost"] as const
  /** `outpost-addrs.json` key + artifact basename of the manager. */
  export const OutpostManagerContractName = "OutpostManager"
  /** Compiled V2 name behind the stable deployment address key. */
  export const OutpostManagerArtifactName = "OutpostManagerV2"
  /** `outpost-addrs.json` key + artifact basename of the inbound endpoint. */
  export const OppInboundContractName = "OPPInbound"
  /** The roster seed entry point on `OPPInbound`. */
  export const InstallInitialRosterFunction = "installInitialRoster"
  /**
   * `epochIndex` the seeded window is anchored at: the active slot serves
   * epoch `0 + 1`, the first inbound epoch. The contract pins the anchor
   * itself; the tuple carries it for shape.
   */
  export const InitialRosterAnchorEpochIndex = 0

  /**
   * Build the `BatchOperatorGroups` tuple for `installInitialRoster`,
   * validating here what `OPPInbound._installInitialRoster` validates on-chain
   * so a bad seed fails with a readable message instead of an
   * `OPP_InvalidInitialRoster` revert: at least one group, no empty group, only
   * well-formed non-zero EVM addresses, no repeat WITHIN a group (a repeat
   * inflates that group's consensus threshold past the operators able to
   * deliver; across groups it is one operator serving consecutive epochs), a
   * positive epoch duration, and an in-range active slot.
   *
   * @param seed - the window + the slot serving epoch 1.
   * @return the tuple, ready to ABI-encode as the call's one argument.
   * @throws on any of the rejections above.
   */
  export function initialBatchOperatorGroups(
    seed: OppBootstrapSeed
  ): InitialBatchOperatorGroups {
    const { window, activeGroupIndex } = seed,
      { groups, epochDurationSec } = window
    Assert.ok(
      groups.length > 0,
      "initial roster: at least one batch-operator group is required"
    )
    Assert.ok(
      Number.isSafeInteger(epochDurationSec) && epochDurationSec > 0,
      `initial roster: epochDurationSec must be a positive integer (got ${epochDurationSec})`
    )
    Assert.ok(
      Number.isSafeInteger(activeGroupIndex) &&
        activeGroupIndex >= 0 &&
        activeGroupIndex < groups.length,
      `initial roster: activeGroupIndex ${activeGroupIndex} is out of range for ${groups.length} group(s)`
    )
    return {
      activeGroupIndex,
      epochIndex: InitialRosterAnchorEpochIndex,
      groups: groups.map((members, groupIndex) => {
        Assert.ok(
          members.length > 0,
          `initial roster: group ${groupIndex} is empty — an empty active group leaves epoch 1 undeliverable by anyone`
        )
        const seen = new Set<string>()
        return {
          operators: members.map(member => {
            Assert.ok(
              EvmAddressPattern.test(member),
              `initial roster: group ${groupIndex} member '${member}' is not an EVM address`
            )
            const normalized = ethers.getAddress(member)
            Assert.ok(
              normalized !== ethers.ZeroAddress,
              `initial roster: group ${groupIndex} contains the zero address`
            )
            Assert.ok(
              !seen.has(normalized),
              `initial roster: ${normalized} appears twice in group ${groupIndex} — a duplicate inflates ` +
                `the consensus threshold beyond the operators able to meet it`
            )
            seen.add(normalized)
            return { kind: ChainKind.EVM, address_: normalized }
          })
        }
      }),
      epochDurationSec
    }
  }

  /** Annotated accounts filename written under the anvil data path. */
  export const AccountsFile = "accounts.json"
  /** Anvil's default deterministic mnemonic. */
  export const AnvilMnemonic =
    "test test test test test test test test test test test junk"
  /** BIP-44 derivation path prefix anvil uses for its accounts. */
  export const DerivationPath = "m/44'/60'/0'/0/"
  /** HD index of the deployer account. */
  export const DeployerAccountIndex = 0
  /**
   * HD index of the emergency-stop panic account the deploy config names
   * (`panicAccount`), which the deploy grants the `panic` role: `pause()` /
   * `unpause()` on the pausable contracts and nothing else. The LAST
   * prefunded anvil account, clear of the operators (from 1), the swap users
   * (32 up) and every flow-owned index (35–47).
   */
  export const PanicAccountIndex = AnvilProcess.AccountCount - 1
  /**
   * `SyndicationPool.maxSyndicationPerTransfer` the deploy sets, in wei — a
   * decimal string, as `deployOutpost.ts` reads it. 1,000 liqETH: the deploy
   * script's own fresh-pool default and the Solana outpost's, named here so a
   * harness cluster never depends on the absent-key path.
   */
  export const MaxSyndicationPerTransferWei = "1000000000000000000000"
  /**
   * `SyndicationPool.yieldDeadband` the deploy sets, in depot units (9
   * decimals) — a decimal string. 0.01 liqETH, the deploy script's fresh-pool
   * default: a `realizeYield` below it is refused, so a flow reporting pool
   * yield donates more than this.
   */
  export const YieldDeadbandDepotUnits = "10000000"
  /** `liqeth.json` / `outpost.json` address-map file of the liqETH deploy. */
  export const LiqEthAddressesFile = "liqeth-addrs.json"
  /** Gas-limit file the liqETH deploy writes. */
  export const LiqEthGasLimitsFile = "liqeth-gas-limits.json"
  /** Gas-limit file the outpost deploy writes. */
  export const OutpostGasLimitsFile = "outpost-gas-limits.json"
  /** The outpost release state the go-live steps record into (`deployLadder.ts` creates it empty). */
  export const OutpostReleaseStateFile = "outpost-release-state.json"
  /** `deployLadder.ts`'s optional config. */
  export const LadderConfigFile = "ladder.json"
  /** What `deployLadder.ts` writes for the orchestrator. */
  export const LadderSummaryFile = "ladder-summary.json"
  /** The deep freeze's `UPGRADE_CONFIG`, written beside the books. */
  export const DeepFreezeConfigFile = "012_outpost_deep_freeze.json"
  /** The go-live's `UPGRADE_CONFIG`, written beside the books. */
  export const GoLiveConfigFile = "013_outpost_go_live.json"
  export const DeepFreezeGasLimitsFile = "012_outpost_deep_freeze-gas-limits.json"
  export const GoLiveGasLimitsFile = "013_outpost_go_live-gas-limits.json"
  /** Hardhat's built-in network every local script runs on; `LOCALHOST_RPC_URL` points it at the run anvil. */
  export const HardhatLocalhostNetwork = "localhost"
  /** The fresh-deploy script (`deployLocal.ts`), relative to the wire-ethereum root. */
  export const DeployLocalScript = "src/scripts/deployLocal.ts"
  /** The ladder script, relative to the wire-ethereum root. */
  export const LadderScript = "src/scripts/deployLadder.ts"
  /** Go-live step 0 — the deep freeze. */
  export const DeepFreezeScript =
    "src/scripts/outpost/upgrades/outpost_20269999.01_deep_freeze.ts"
  /** Go-live step 1 — pool upgrade, fresh OPP pair and BAR, re-wiring. */
  export const GoLiveScript =
    "src/scripts/outpost/upgrades/outpost_20269999.02_go_live.ts"
  /**
   * The CREATE2 salt version the go-live deploys its fresh proxies under —
   * never the ladder's (mainnet deployed under `outpost_v2`, the ladder under
   * "2"), so the fresh pair cannot collide with the originals.
   */
  export const GoLiveSaltVersion = "3"
  /** `DepositManager` entry-queue length the local liqETH deploy configures. */
  export const LiqEthEntryQueue = 47
  /** `DepositManager` daily rate (bps) the local liqETH deploy configures. */
  export const LiqEthDailyRateBps = 283
  /** `DepositManager` reward cooldown the local liqETH deploy configures. */
  export const LiqEthRewardCooldown = 100
  /** Withdrawal delay the local liqETH deploy configures. */
  export const LiqEthWithdrawalDelay = 50

  /**
   * The `liqeth.json` deploy config `deployLocal.ts` reads. A pure value
   * helper, so the written JSON is unit-testable without hardhat.
   *
   * `panicAccount` rides here too: every `DeployScript` grants the `panic`
   * role from its OWN config (`deployScript.ts` `applyPermissions`), so the
   * liqETH contracts' pause role follows this key, not the outpost's.
   *
   * @param rpcUrl - The run anvil's endpoint.
   * @param deployerPrivateKey - The deployer (anvil HD index 0) key.
   * @param deploymentsPath - This cluster's deploy-artifact dir.
   * @param panicAccount - The panic account's address.
   * @returns The config object written as `liqeth.json`.
   */
  export function liqEthDeployConfig(
    rpcUrl: string,
    deployerPrivateKey: string,
    deploymentsPath: string,
    panicAccount: string
  ) {
    return {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(deploymentsPath, LiqEthAddressesFile),
      gasLimitFile: Path.join(deploymentsPath, LiqEthGasLimitsFile),
      entryQueue: LiqEthEntryQueue,
      dailyRateBPS: LiqEthDailyRateBps,
      rewardCooldown: LiqEthRewardCooldown,
      withdrawalDelay: LiqEthWithdrawalDelay,
      panicAccount
    }
  }

  /**
   * The `outpost.json` deploy config `deployLocal.ts` reads. A pure value
   * helper, so the written JSON is unit-testable without hardhat.
   *
   * The three syndication keys are the ones `deployOutpost.ts` resolves
   * (`panicAccount`, `maxSyndicationPerTransfer`, `yieldDeadband`), each
   * named explicitly so the pool's configuration never rests on the script's
   * absent-key defaults.
   *
   * @param rpcUrl - The run anvil's endpoint.
   * @param deployerPrivateKey - The deployer (anvil HD index 0) key.
   * @param deploymentsPath - This cluster's deploy-artifact dir.
   * @param panicAccount - The panic account's address.
   * @param initialRoster - The WNE-41 roster `OPPInbound.initialize` seats.
   * @returns The config object written as `outpost.json`.
   */
  export function outpostDeployConfig(
    rpcUrl: string,
    deployerPrivateKey: string,
    deploymentsPath: string,
    panicAccount: string,
    initialRoster: EthereumOutpostInitialRoster
  ) {
    return {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(deploymentsPath, OutpostAddressesFile),
      gasLimitFile: Path.join(deploymentsPath, OutpostGasLimitsFile),
      useMockAggregator: true,
      // WNE-41: consumed by `deployLocal.ts`'s OutpostLocalDeploy, which
      // hands them to `OPPInbound.initialize`. The deployer is deliberately
      // NOT among them — on a cluster the batch-operator daemons sign
      // `epochIn` with their own keys.
      initialOperatorGroups: initialRoster.groups,
      epochDurationSec: initialRoster.epochDurationSec,
      panicAccount,
      maxSyndicationPerTransfer: MaxSyndicationPerTransferWei,
      yieldDeadband: YieldDeadbandDepotUnits
    }
  }

  /**
   * The `ladder.json` config `deployLadder.ts` reads: the panic account the
   * liqEth ladder's permissions grant; every other key defaults. A pure value
   * helper.
   *
   * @param panicAccount - The panic account's address.
   * @returns The config object written as `ladder.json`.
   */
  export function ladderConfig(panicAccount: string) {
    return { panicAccount }
  }

  /**
   * The deep freeze's `UPGRADE_CONFIG`: the ladder's outpost book and release
   * state under the go-live salt. A pure value helper.
   *
   * @param rpcUrl - The run anvil's endpoint.
   * @param deployerPrivateKey - The deploy owner (anvil HD index 0) key.
   * @param deploymentsPath - This cluster's deploy-artifact dir.
   * @returns The config object written as {@link DeepFreezeConfigFile}.
   */
  export function deepFreezeConfig(
    rpcUrl: string,
    deployerPrivateKey: string,
    deploymentsPath: string
  ) {
    return {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(deploymentsPath, OutpostAddressesFile),
      releaseStateFile: Path.join(deploymentsPath, OutpostReleaseStateFile),
      gasLimitFile: Path.join(deploymentsPath, DeepFreezeGasLimitsFile),
      saltVersion: GoLiveSaltVersion
    }
  }

  /**
   * The go-live's `UPGRADE_CONFIG`: the books, the release state the freeze
   * recorded the booked figure into, the go-live salt, the provisional roster
   * the fresh `OPPInbound` seats, the WireNodes stand-in, and the same pool
   * parameters the fresh deploy names. A pure value helper.
   *
   * @param rpcUrl - The run anvil's endpoint.
   * @param deployerPrivateKey - The deploy owner (anvil HD index 0) key.
   * @param deploymentsPath - This cluster's deploy-artifact dir.
   * @param panicAccount - The panic account's address.
   * @param initialRoster - The WNE-41 roster the fresh `OPPInbound` seats.
   * @param wireNodes - The WireNodes ERC-1155 BAR draws claims from.
   * @returns The config object written as {@link GoLiveConfigFile}.
   */
  export function goLiveConfig(
    rpcUrl: string,
    deployerPrivateKey: string,
    deploymentsPath: string,
    panicAccount: string,
    initialRoster: EthereumOutpostInitialRoster,
    wireNodes: string
  ) {
    return {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(deploymentsPath, OutpostAddressesFile),
      liqEthAddressFile: Path.join(deploymentsPath, LiqEthAddressesFile),
      releaseStateFile: Path.join(deploymentsPath, OutpostReleaseStateFile),
      gasLimitFile: Path.join(deploymentsPath, GoLiveGasLimitsFile),
      saltVersion: GoLiveSaltVersion,
      initialOperatorGroups: initialRoster.groups,
      epochDurationSec: initialRoster.epochDurationSec,
      panicAccount,
      WireNodes: wireNodes,
      maxSyndicationPerTransfer: MaxSyndicationPerTransferWei,
      yieldDeadband: YieldDeadbandDepotUnits
    }
  }

  /**
   * Assert every operator's EM HD index — batch operators from
   * {@link Constants.batchOperatorEthereumHdIndex}, underwriters from
   * {@link Constants.underwriterEthereumHdIndex} — sits below
   * {@link PanicAccountIndex}, so no operator key is the panic account.
   *
   * @param batchOperatorCount - The cluster's batch-operator count.
   * @param underwriterCount - The cluster's underwriter count.
   * @throws If the highest operator index reaches the panic account's.
   */
  export function assertOperatorsClearOfPanicAccount(
    batchOperatorCount: number,
    underwriterCount: number
  ): void {
    const highest = Math.max(
      Constants.batchOperatorEthereumHdIndex(batchOperatorCount - 1),
      Constants.underwriterEthereumHdIndex(
        batchOperatorCount,
        underwriterCount - 1
      )
    )
    Assert.ok(
      highest < PanicAccountIndex,
      `EthereumOutpostBootstrapper: ${batchOperatorCount} batch operators and ${underwriterCount} ` +
        `underwriters reach HD index ${highest}, which is not below the panic account's ` +
        `${PanicAccountIndex}`
    )
  }

  /**
   * The anvil HD wallet at `hdIndex` — the account anvil prefunds under its
   * default mnemonic. A pure value helper.
   *
   * @param hdIndex - The HD account index.
   * @returns The wallet (unconnected).
   */
  export function anvilWallet(hdIndex: number): ethers.HDNodeWallet {
    return ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(AnvilMnemonic),
      `${DerivationPath}${hdIndex}`
    )
  }
  /** Deploy-artifact files cleared before every deploy (stale-address guard). */
  export const StaleDeployArtifactFiles = [
    LiqEthAddressesFile,
    OutpostAddressesFile
  ] as const
  /**
   * Host-global lock serializing the hardhat deploy subprocess across every
   * wire process: parallel deploys share `<wire-ethereum>`'s compile
   * cache/artifacts, and concurrent hardhat compiles corrupt them. Per-run
   * deploy STATE is isolated separately (see `deploymentsPath`).
   */
  export const HardhatDeployLockPath = Path.join(
    Os.tmpdir(),
    "wire-ethereum-hardhat-deploy.lock"
  )
  /** Hardhat deploy subprocess timeout (ms). */
  export const HardhatDeployTimeoutMs = 600_000
  /** Hardhat deploy subprocess stdout/stderr buffer cap (bytes). */
  export const HardhatDeployBufferBytes = 10 * 1_024 * 1_024
  /** Chars of Hardhat stderr logged after a run. */
  export const HardhatStderrTailChars = 1_000
  /** Chars of Hardhat stdout logged after a run. */
  export const HardhatStdoutTailChars = 500

  /** Resolve the default (overridable) options. `accountCount` tracks the run
   *  anvil's `--accounts` so every generated account is pre-funded. */
  export function createDefaultOptions(): Partial<EthereumOutpostBootstrapperOptions> {
    return {
      accountCount: AnvilProcess.AccountCount
    }
  }

  /**
   * Generate `count` deterministic accounts from anvil's default mnemonic —
   * they match exactly what anvil generates internally.
   */
  export function generateAccounts(count: number): EthereumAccount[] {
    return range(count).map(index => {
      const wallet = anvilWallet(index)
      return {
        address: wallet.address,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        usedInBootstrap: false,
        usedFor: ""
      }
    })
  }
}
