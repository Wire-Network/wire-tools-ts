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
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import {
  LongFileLockOptions,
  mkdirs,
  withFileLock
} from "../../utils/fsUtils.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"
import { EvmAddressPattern, loadOutpostContract } from "../../utils/ethereumUtils.js"

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
 * seed the `ReserveManager` with physical custody, and write an annotated
 * accounts file.
 *
 * The run anvil is started separately (`Steps.processes.anvil.start`) and owned
 * by the process manager for the whole cluster lifecycle — this bootstrapper
 * never spawns its own anvil; it only deploys against the one it is handed.
 *
 * Test-cluster custody priming (`seedReserveManager`) lives HERE in the
 * harness, never in `wire-ethereum`'s `deployLocal.ts` — it runs after the
 * deploy returns and owns its own nonce counter.
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
   * contracts against the running anvil → seed the ReserveManager → write the
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
    // Seed ReserveManager AFTER deploy so `outpost-addrs.json` reflects the
    // final addresses; the depot's logical `sysio.reserv` view and the
    // outpost's physical custody are independent ledgers (a non-native dst
    // SwapRemit can only draw against physically-funded custody).
    await this.seedReserveManager(rpcUrl)

    const accountsFile = Path.join(
      mkdirs(anvilDataPath),
      EthereumOutpostBootstrapper.AccountsFile
    )
    Fs.writeFileSync(accountsFile, JSON.stringify(this.accounts, null, 2))
    log.info(
      `[ethereum] wrote ${this.accounts.length} accounts to ${accountsFile}`
    )

    return this.accounts
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

    const liqEthConfig = {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(localDir, "liqeth-addrs.json"),
      gasLimitFile: Path.join(localDir, "liqeth-gas-limits.json"),
      entryQueue: 47,
      dailyRateBPS: 283,
      rewardCooldown: 100,
      withdrawalDelay: 50
    }
    const { initialRoster } = this.config,
      outpostConfig = {
        url: rpcUrl,
        key: deployerPrivateKey,
        addressFile: Path.join(localDir, "outpost-addrs.json"),
        gasLimitFile: Path.join(localDir, "outpost-gas-limits.json"),
        useMockAggregator: true,
        // WNE-41: consumed by `deployLocal.ts`'s OutpostLocalDeploy, which
        // hands them to `OPPInbound.initialize`. The deployer is deliberately
        // NOT among them — on a cluster the batch-operator daemons sign
        // `epochIn` with their own keys.
        initialOperatorGroups: initialRoster.groups,
        epochDurationSec: initialRoster.epochDurationSec
      }
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

    log.info("[ethereum] running deployLocal.ts via hardhat...")
    StepExtraRecorder.record({
      client: "process",
      kind: "exec",
      command: [
        "npx",
        "hardhat",
        "run",
        "src/scripts/deployLocal.ts",
        "--network",
        "localhost"
      ],
      cwd: ethereumPath
    })
    // withFileLock: hardhat compiles into the SHARED repo cache/artifacts on
    // demand — two concurrent compiles corrupt them. The per-run state (configs
    // + address files) is already isolated via deploymentsPath.
    const { stdout, stderr } = await withFileLock(
      EthereumOutpostBootstrapper.HardhatDeployLockPath,
      () =>
        execFileAsync(
          "npx",
          [
            "hardhat",
            "run",
            "src/scripts/deployLocal.ts",
            "--network",
            "localhost"
          ],
          {
            cwd: ethereumPath,
            timeout: scaleTimeoutMs(
              EthereumOutpostBootstrapper.HardhatDeployTimeoutMs
            ),
            maxBuffer: EthereumOutpostBootstrapper.HardhatDeployBufferBytes,
            env: {
              ...process.env,
              HARDHAT_NETWORK: "localhost",
              WIRE_ETH_DEPLOYMENTS_PATH: localDir
            }
          }
        ),
      LongFileLockOptions
    )
    if (stderr)
      log.debug(
        `[ethereum] hardhat stderr:\n${stderr.slice(0, EthereumOutpostBootstrapper.HardhatStderrTailChars)}`
      )
    log.info(
      `[ethereum] deploy output:\n${stdout.slice(-EthereumOutpostBootstrapper.HardhatStdoutTailChars)}`
    )

    EthereumOutpostBootstrapper.StaleDeployArtifactFiles.forEach(name => {
      const file = Path.join(localDir, name)
      if (Fs.existsSync(file)) {
        const contents = Fs.readFileSync(file, "utf-8")
        log.info(`[ethereum] ${name}: ${contents}`)
        // The deploy's OUTPUT — the deployed contract addresses — is the
        // step's payload; land each artifact file in the step extra.
        StepExtraRecorder.record({
          client: "harness",
          kind: "artifact",
          file: name,
          contents: JSON.parse(contents) as Record<string, unknown>
        })
      }
    })
    log.info("[ethereum] contract deployment complete")
  }

  /**
   * Send native ETH + mock ERC-20 (USDC / USDT / LIQETH) from the deployer
   * wallet to `ReserveManager` so its physical custody matches the depot's
   * `sysio.reserv::regreserve` logical view. Uses a single owner-managed nonce
   * counter (seeded once from `getNonce("pending")`, incremented per tx) to
   * avoid the back-to-back-tx nonce race.
   */
  private async seedReserveManager(rpcUrl: string): Promise<void> {
    const outpostAddressesFile = Path.join(
      this.config.deploymentsPath,
      "outpost-addrs.json"
    )
    if (!Fs.existsSync(outpostAddressesFile)) {
      log.warn(
        "[ethereum] seedReserveManager: outpost-addrs.json missing, skipping"
      )
      return
    }
    const addresses = JSON.parse(Fs.readFileSync(outpostAddressesFile, "utf-8"))
    const {
      ReserveManager: reserveManagerAddress,
      MockUsdc: mockUsdcAddress,
      MockUsdt: mockUsdtAddress
    } = addresses
    if (reserveManagerAddress == null) {
      log.warn(
        "[ethereum] seedReserveManager: ReserveManager address missing, skipping"
      )
      return
    }

    // Bind the deployer (anvil HD index 0) — the same identity deployLocal.ts
    // used as `owner`, so its minted MockUSDC/USDT balances are available here.
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const deployer = new ethers.Wallet(
      this.accounts[EthereumOutpostBootstrapper.DeployerAccountIndex]
        .privateKey,
      provider
    )
    let nonce = await deployer.getNonce("pending")
    log.info(
      `[ethereum] seedReserveManager start (deployer=${deployer.address}, nonce=${nonce})`
    )

    const nativeSeed = ethers.parseEther(
      EthereumOutpostBootstrapper.NativeSeedEther
    )
    const stableSeed = ethers.parseUnits(
      EthereumOutpostBootstrapper.StableSeedUnits,
      EthereumOutpostBootstrapper.StableDecimals
    )

    log.info(
      `[ethereum] seed ${ethers.formatEther(nativeSeed)} ETH (nonce ${nonce})`
    )
    const ethTx = await deployer.sendTransaction({
      to: reserveManagerAddress,
      value: nativeSeed,
      nonce: nonce++
    })
    await ethTx.wait()

    const transferStable = async (
      tokenAddress: string,
      label: string
    ): Promise<void> => {
      log.info(
        `[ethereum] seed ${ethers.formatUnits(stableSeed, 6)} ${label} (nonce ${nonce})`
      )
      const token = new ethers.Contract(
        tokenAddress,
        EthereumOutpostBootstrapper.Erc20Abi,
        deployer
      )
      const tx = await token.transfer(reserveManagerAddress, stableSeed, {
        nonce: nonce++
      })
      await tx.wait()
    }
    if (mockUsdcAddress != null) await transferStable(mockUsdcAddress, "USDC")
    if (mockUsdtAddress != null) await transferStable(mockUsdtAddress, "USDT")

    // LIQETH only if the LiqEth deploy went through (toggled off for outpost-only runs).
    const { LiqEth: liqEthAddress } = addresses
    if (liqEthAddress != null) {
      const liqEthSeed = ethers.parseEther(
        EthereumOutpostBootstrapper.NativeSeedEther
      )
      const liqEth = new ethers.Contract(
        liqEthAddress,
        EthereumOutpostBootstrapper.Erc20Abi,
        deployer
      )
      const ownerLiqEthBalance: bigint = await liqEth.balanceOf(
        deployer.address
      )
      if (ownerLiqEthBalance >= liqEthSeed) {
        log.info(
          `[ethereum] seed ${ethers.formatEther(liqEthSeed)} LIQETH (nonce ${nonce})`
        )
        const liqEthTx = await liqEth.transfer(
          reserveManagerAddress,
          liqEthSeed,
          { nonce: nonce++ }
        )
        await liqEthTx.wait()
      } else {
        log.info(
          `[ethereum] skip LIQETH seed (deployer balance ${ethers.formatEther(ownerLiqEthBalance)} < ${ethers.formatEther(liqEthSeed)})`
        )
      }
    }
    log.info("[ethereum] seedReserveManager complete")
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
  async oppBootstrap(seed: EthereumOutpostBootstrapper.OppBootstrapSeed): Promise<void> {
    const { ethereumPath, deploymentsPath, rpcUrl } = this.config,
      initialGroups = EthereumOutpostBootstrapper.initialBatchOperatorGroups(seed),
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
      manager = loadOutpostContract<EthereumOutpostBootstrapper.OutpostManagerExecuteView>(
        ethereumPath,
        outpostAddresses,
        EthereumOutpostBootstrapper.OutpostManagerContractName,
        [...EthereumOutpostBootstrapper.OutpostArtifactSubpath],
        deployer
      ),
      oppInbound = loadOutpostContract<EthereumOutpostBootstrapper.OppInboundRosterView>(
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
    log.info("[ethereum] installInitialRoster: ETH outpost roster seeded on the depot's schedule")
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
    execute(target: string, data: string): Promise<ethers.ContractTransactionResponse>
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
  export function initialBatchOperatorGroups(seed: OppBootstrapSeed): InitialBatchOperatorGroups {
    const { window, activeGroupIndex } = seed,
      { groups, epochDurationSec } = window
    Assert.ok(groups.length > 0, "initial roster: at least one batch-operator group is required")
    Assert.ok(
      Number.isSafeInteger(epochDurationSec) && epochDurationSec > 0,
      `initial roster: epochDurationSec must be a positive integer (got ${epochDurationSec})`
    )
    Assert.ok(
      Number.isSafeInteger(activeGroupIndex) && activeGroupIndex >= 0 && activeGroupIndex < groups.length,
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
  /** Deploy-artifact files cleared before every deploy (stale-address guard). */
  export const StaleDeployArtifactFiles = [
    "liqeth-addrs.json",
    "outpost-addrs.json"
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
  /** Native ETH amount seeded into ReserveManager. */
  export const NativeSeedEther = "100"
  /** Stable-coin amount seeded into ReserveManager (whole units). */
  export const StableSeedUnits = "100"
  /** Decimals for the mock stable-coins (USDC / USDT). */
  export const StableDecimals = 6
  /** Minimal ERC-20 ABI for the custody-seeding transfers. */
  export const Erc20Abi = [
    "function transfer(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)"
  ] as const

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
    const mnemonic = ethers.Mnemonic.fromPhrase(AnvilMnemonic)
    return range(count).map(index => {
      const wallet = ethers.HDNodeWallet.fromMnemonic(
        mnemonic,
        `${DerivationPath}${index}`
      )
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
