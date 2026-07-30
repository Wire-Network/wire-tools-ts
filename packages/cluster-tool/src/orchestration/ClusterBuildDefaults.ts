import Assert from "node:assert"

import { LAMPORTS_PER_SOL } from "@solana/web3.js"
import { range } from "lodash"

import type {
  ClusterConfig,
  CollateralRequirement
} from "@wireio/cluster-tool-shared"
import {
  ChainKind,
  NodeOwnerTier,
  OperatorType
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { Constants } from "../Constants.js"
import { BatchOperatorSchedule } from "../config/BatchOperatorSchedule.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { NodeConfig, NodeRole, producerName } from "../config/NodeConfig.js"
import { type Logger } from "../logging/Logger.js"
import { Report } from "../report/Report.js"
import { AuthExLinkTool } from "../tools/all/AuthExLinkTool.js"
import {
  readNodeOwner,
  readNodeOwnerReg
} from "../tools/ethereum/EthereumNodeOwnerNftTool.js"
import { OperatorDaemonTool } from "../tools/wire/OperatorDaemonTool.js"
import {
  convertImportSeedCredits,
  loadIndexBalanceDump,
  type ImportSeedChainKind
} from "../tools/wire/WireDclaimSeedTool.js"
import { WireOperatorProvisioningTool } from "../tools/wire/WireOperatorProvisioningTool.js"
import { mapSeries } from "../utils/asyncUtils.js"
import { ClusterBuild } from "./ClusterBuild.js"
import { ClusterBuildContext } from "./ClusterBuildContext.js"
import { ClusterBuildPhase } from "./ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "./ClusterBuildPhaseGroup.js"
import {
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapSource,
  finalizeDistributionClaimBootstrap,
  type DistributionClaimBootstrapContribution,
  type DistributionClaimBootstrapCore
} from "./outputs/DistributionClaimBootstrapOutput.js"
import { ContractSteps } from "./steps/ContractSteps.js"
import { Steps } from "./steps/index.js"
import { verifyStep } from "./StepTools.js"

const { SysioContractName } = SysioContracts
const { DeployMode } = ContractSteps
const { Actor } = Report

enum DistributionClaimChainLabel {
  Ethereum = "Ethereum",
  Solana = "Solana"
}

interface ConfiguredDistributionClaimInput {
  readonly chain: ImportSeedChainKind
  readonly file: string
}

/** The initial SYS supply + per-producer grant (core resource token). */
const InitialSysSupply = "1000000000.0000 SYS"
const ProducerSysGrant = "1000000.0000 SYS"
/** The WIRE emissions token supply (9-decimal). */
const WireSupply = "1000000000.000000000 WIRE"
/** WIRE-leg swap fee (bps) + collateral-lock challenge window (dev). */
const SwapFeeBps = 30
const CollateralLockDurationMs = 600_000
/**
 * Minimum `swapfromwire` escrow (9-dec base units). The contract default is
 * 5 WIRE; dev clusters lower it to exactly the 0.1 WIRE escrow the
 * swap-from-WIRE flow pushes — the same way they shorten the collateral-lock
 * window — so the enqueue boundary stays exercised without re-baselining flow
 * economics.
 */
const MinFromWireAmount = 100_000_000
/**
 * Fee (bps of the escrow) forfeited on caller-fault drain-time reverts of
 * queued `swapfromwire` rows (zero quote / missed variance at `drainfwq`),
 * routed like the settlement fee. Mirrors the contract default; happy-path
 * flows never pay it and system-caused reverts refund in full.
 */
const FromWireRevertFeeBps = 10
/** Epoch envelope-log retention. */
const EnvelopeLogRetentionEpochs = 10
/** Dev-default `terminate_max_consecutive_misses` (per-flow overridable via ClusterConfig). */
const DefaultTerminateMaxConsecutiveMisses = 5
/** Dev-default `terminate_max_pct_misses_24h` (per-flow overridable via ClusterConfig). */
const DefaultTerminateMaxPercentMisses24h = 5
/** Dev-default `terminate_window_ms` — 24h (per-flow overridable via ClusterConfig). */
const DefaultTerminateWindowMs = 24 * 60 * 60 * 1000
/**
 * Lamports airdropped to each bootstrapped batch operator's SOL keypair — their
 * daemons PAY the fees on every `epoch_in` delivery, every epoch, for the whole
 * run (an unfunded fee payer fails simulation with `AccountNotFound` and stalls
 * SOL-outpost consensus). Matches the old launcher's 100-SOL seed.
 */
const BatchOperatorAirdropLamports = 100n * BigInt(LAMPORTS_PER_SOL)

/**
 * Builds a {@link ClusterBuild} pre-loaded with the full bootstrap, organized into
 * two top-level phase groups: **Cluster Prerequisites** (processes, keys, system +
 * OPP contracts, registry, outposts, and PRODUCER operators) and **Cluster Post
 * Contract Deployment** (batch operators + underwriters, operator nodes, first
 * epoch). Every operator — producer, batch, underwriter — is provisioned through the
 * ONE {@link WireOperatorProvisioningTool.planOperatorAccountProvisioning} mechanism into per-account
 * {@link OperatorAccount}s. Composed entirely from the {@link Steps} palette. The CLI
 * `create` command runs `create(options).build()`.
 */
export namespace ClusterBuildDefaults {
  /**
   * Resolve config and context, prepare the complete distribution-claim input,
   * then compose the bootstrap phases. The optional flow hook runs after
   * configured files are validated and before composition; its credit sets are
   * additive to configured-file sets and cannot replace them.
   *
   * @param options - Cluster creation and persisted configuration options.
   * @param createContext - Optional factory for a flow-specific build context.
   * @param prepareDistributionClaimBootstrap - Optional flow hook contributing
   *   additional validated credit sets before the import Steps are composed.
   * @returns The fully composed cluster build.
   */
  export async function create<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    options: ClusterBuildOptions = {},
    createContext?: (config: ClusterConfig, log: Logger) => C,
    prepareDistributionClaimBootstrap?: (
      cluster: ClusterBuild<C>,
      core: DistributionClaimBootstrapCore
    ) => Promise<DistributionClaimBootstrapContribution>
  ): Promise<ClusterBuild<C>> {
    const cluster = await ClusterBuild.create<C>(options, [], createContext)
    const core = await loadConfiguredDistributionClaimBootstrap(cluster.config)
    const contribution =
      (await prepareDistributionClaimBootstrap?.(cluster, core)) ?? null
    const result = finalizeDistributionClaimBootstrap(core, contribution)
    cluster.context.outputs.set(DistributionClaimBootstrapResultKey, result)
    logDistributionClaimBootstrap(cluster.context.log, result)
    compose(cluster)
    return cluster
  }

  /** Compose every bootstrap phase onto `cluster` (order = the top-level sequence). */
  function compose<C extends ClusterBuildContext>(
    cluster: ClusterBuild<C>
  ): void {
    const config = cluster.context.config,
      producers = range(config.producerCount).map(index => producerName(index)),
      batchOperators = range(config.batchOperatorCount).map(index =>
        Constants.batchOperatorLabel(index)
      ),
      underwriters = range(config.underwriterCount).map(index =>
        Constants.underwriterLabel(index)
      ),
      producerNodes = NodeConfig.plan(config).filter(
        node => node.role === NodeRole.producer
      ),
      producerNodeCount = producerNodes.length,
      // External-outpost mode: the ETH + SOL outposts already run on real chains
      // (`config.externalOutposts`), so skip the local anvil/validator starts +
      // outpost deploys and publish the operator-daemon artifacts from the
      // external config instead (verifying the endpoints are reachable).
      isExternalOutpost = config.externalOutposts != null

    // ═══ Cluster Prerequisites — processes, keys, contracts, registry, producers ═══
    const prerequisites = ClusterBuildPhaseGroup.create<C>(
      cluster,
      "Cluster Prerequisites",
      "Processes, keys, system + OPP contracts, registry, outposts, and producer operators"
    )

    // ── processes + keys + producing nodes ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Kiod",
      "Start the kiod wallet daemon"
    ).push(
      Steps.processes.kiod.planStart<C>(
        Actor.Sysio,
        "start-kiod",
        "start kiod",
        {}
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "WalletAndKeys",
      "Generate producer node keys + open the wallet"
    ).push(
      Steps.keys.planGenerateNodeKeys<C>(
        Actor.Sysio,
        "generate-keys",
        "generate producer node keys",
        {}
      ),
      Steps.keys.planCreateWallet<C>(
        Actor.Sysio,
        "create-wallet",
        "open wallet + import BIOS/node keys",
        {}
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "BiosNode",
      "Start the bios node"
    ).push(
      Steps.processes.nodeop.planStart<C>(
        Actor.Sysio,
        "start-bios",
        "start bios node",
        {},
        NodeConfig.BiosName
      )
    )
    const producerNodeGroup = ClusterBuildPhaseGroup.create<C>(
      prerequisites,
      "ProducerNodes",
      "Start producer nodes",
      { parallel: true }
    )
    producerNodes.forEach(node =>
      ClusterBuildPhase.create<C>(
        producerNodeGroup,
        node.name,
        `Start ${node.name}`
      ).push(
        Steps.processes.nodeop.planStart<C>(
          Actor.Producer,
          `start-${node.name}`,
          `start ${node.name}`,
          {},
          node.name
        )
      )
    )

    // ── bios contract + features + finality ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "BiosContract",
      "Deploy sysio.bios (raw)"
    ).push(
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-bios",
        "set contract sysio.bios",
        {},
        SysioContractName.bios,
        DeployMode.raw
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Features",
      "Activate protocol features"
    ).push(
      Steps.protocol.planActivateFeatures<C>(
        Actor.Sysio,
        "activate-features",
        "activate all supported protocol features",
        {}
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Finality",
      "Activate BLS instant finality"
    ).push(
      Steps.consensus.planSetFinalizer<C>(
        Actor.Sysio,
        "set-finalizer",
        "set the BLS finalizer policy from node keys",
        {}
      )
    )

    // ── bring-up accounts + system + roa ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "BringUpAccounts",
      "Create sysio.roa + sysio.acct"
    ).push(
      Steps.account.planCreateSystem<C>(
        Actor.Sysio,
        "create-roa",
        "create sysio.roa",
        {},
        "sysio.roa"
      ),
      Steps.account.planCreateSystem<C>(
        Actor.Sysio,
        "create-acct",
        "create sysio.acct",
        {},
        "sysio.acct"
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "SystemContract",
      "Deploy sysio.system (raw)"
    ).push(
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-system",
        "set contract sysio.system",
        {},
        SysioContractName.system,
        DeployMode.raw
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Roa",
      "Deploy sysio.roa + setpriv + activateroa"
    ).push(
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-roa",
        "set contract sysio.roa",
        {},
        SysioContractName.roa,
        DeployMode.raw
      ),
      Steps.contracts.sysio.system.planSetpriv<C>(
        Actor.Sysio,
        "setpriv-roa",
        "mark sysio.roa privileged",
        {},
        {
          account: "sysio.roa",
          is_priv: 1
        }
      ),
      Steps.contracts.sysio.roa.planActivateroa<C>(
        Actor.Sysio,
        "activate-roa",
        "activate ROA (finite RAM gifting)",
        {},
        {
          total_sys: Constants.ROA_TOTAL_SYS,
          bytes_per_unit: Constants.ROA_BYTES_PER_UNIT
        }
      )
    )

    // ── producer operators + remaining system accounts + handoff ──
    // Producers are operators: provisioned through the ONE mechanism, each account
    // materializing its (round-robin, node-shared) K1+BLS into an OperatorAccount.
    WireOperatorProvisioningTool.planOperatorAccountProvisioning<C>(
      prerequisites,
      "Producers",
      "Provision producer operators (account + node-shared identity)",
      {},
      producers.map((label, index) => ({
        label,
        type: OperatorType.PRODUCER,
        producerNodeIndex: producerNodeCount > 0 ? index % producerNodeCount : 0
      }))
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "RemainingSystemAccounts",
      "Create remaining sysio.* accounts"
    ).push(
      ...Constants.SYSTEM_ACCOUNTS.filter(
        account => account !== "sysio.roa" && account !== "sysio.acct"
      ).map(account =>
        Steps.account.planCreateSystem<C>(
          Actor.Sysio,
          `create-${account}`,
          `create ${account}`,
          {},
          account
        )
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "ProducerHandoff",
      "Set producers + hand off from sysio"
    ).push(
      Steps.consensus.planSetProducerKeys<C>(
        Actor.Sysio,
        "set-producer-keys",
        "set producer schedule + await handoff",
        { timeoutMs: 300_000 }
      )
    )

    // ── token (SYS) + authex/msig/wrap ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "TokenContract",
      "Deploy sysio.token (system) + distribute SYS"
    ).push(
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-token",
        "setsyscode sysio.token",
        {},
        SysioContractName.token,
        DeployMode.system
      ),
      Steps.contracts.sysio.token.planCreate<C>(
        Actor.Sysio,
        "create-sys",
        "create the SYS token",
        {},
        { issuer: "sysio", maximum_supply: InitialSysSupply }
      ),
      Steps.contracts.sysio.token.planIssue<C>(
        Actor.Sysio,
        "issue-sys",
        "issue SYS to sysio",
        {},
        { to: "sysio", quantity: InitialSysSupply, memo: "initial issue" }
      ),
      ...producers.map(account =>
        Steps.contracts.sysio.token.planTransfer<C>(
          Actor.Sysio,
          `grant-${account}`,
          `grant SYS to ${account}`,
          {},
          {
            from: "sysio",
            to: account,
            quantity: ProducerSysGrant,
            memo: "init"
          }
        )
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "AuthexMsigWrap",
      "Deploy sysio.authex + sysio.msig + sysio.wrap"
    ).push(
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-authex",
        "setsyscode sysio.authex",
        {},
        SysioContractName.authex,
        DeployMode.system
      ),
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-msig",
        "setsyscode sysio.msig",
        {},
        SysioContractName.msig,
        DeployMode.system
      ),
      Steps.contract.planDeploy<C>(
        Actor.Sysio,
        "deploy-wrap",
        "setsyscode sysio.wrap",
        {},
        SysioContractName.wrap,
        DeployMode.system
      )
    )

    // ── OPP contracts + sysio.code grants ──
    const oppContracts = [
      SysioContractName.chains,
      SysioContractName.tokens,
      SysioContractName.epoch,
      SysioContractName.opreg,
      SysioContractName.msgch,
      SysioContractName.uwrit,
      SysioContractName.reserv,
      SysioContractName.chalg,
      SysioContractName.dclaim
    ]
    ClusterBuildPhase.create<C>(
      prerequisites,
      "OPPContracts",
      "Deploy the OPP system contracts"
    ).push(
      ...oppContracts.map(contract =>
        Steps.contract.planDeploy<C>(
          Actor.Sysio,
          `deploy-${contract}`,
          `setsyscode sysio.${contract}`,
          {},
          contract,
          DeployMode.system
        )
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "OPPCodeGrants",
      "Grant sysio.code on the OPP contract authorities"
    ).push(
      ...Constants.OPP_SYSTEM_ACCOUNTS.map(account =>
        Steps.contract.planGrantSysioCode<C>(
          Actor.Sysio,
          `grant-${account}`,
          `grant @sysio.code to ${account}`,
          {},
          account
        )
      )
    )

    // ── OPP config + emissions + dclaim ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "OPPConfig",
      "Configure sysio.epoch + sysio.opreg"
    ).push(
      Steps.contracts.sysio.epoch.planSetconfig<C>(
        Actor.Sysio,
        "configure-epoch",
        "set the global epoch config",
        {},
        epochConfig(config)
      ),
      Steps.contracts.sysio.opreg.planSetconfig<C>(
        Actor.Sysio,
        "configure-opreg",
        "set the operator-registry config",
        {},
        operatorRegistryConfig(config)
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Emissions",
      "Seed WIRE + configure emissions"
    ).push(
      Steps.contracts.sysio.token.planCreate<C>(
        Actor.Sysio,
        "create-wire",
        "create the WIRE token",
        {},
        { issuer: "sysio", maximum_supply: WireSupply }
      ),
      Steps.contracts.sysio.token.planIssue<C>(
        Actor.Sysio,
        "issue-wire",
        "issue WIRE to sysio",
        {},
        {
          to: "sysio",
          quantity: WireSupply,
          memo: "initial WIRE for emissions"
        }
      ),
      Steps.contracts.sysio.system.planSetemitcfg<C>(
        Actor.Sysio,
        "set-emit-config",
        "set the emission config",
        {},
        Constants.EMISSION_CONFIG_DEFAULTS
      ),
      Steps.contracts.sysio.system.planInitt5<C>(
        Actor.Sysio,
        "init-t5",
        "seed t5_state at chain head time",
        {}
      )
    )
    const distributionClaims = ClusterBuildPhase.create<C>(
      prerequisites,
      "DistributionClaims",
      "Initialize and optionally seed sysio.dclaim"
    )
    distributionClaims.push(
      Steps.contracts.sysio.dclaim.planSetconfig<C>(
        Actor.Sysio,
        "init-dclaim",
        "initialize the dclaim cap_config",
        {}
      )
    )
    const bootstrap = cluster.context.outputs.assert(
      DistributionClaimBootstrapResultKey
    )
    bootstrap.chains.forEach(chainResult => {
      const chain = distributionClaimChainLabel(chainResult.chain).toLowerCase()
      chainResult.batches.forEach((batch, batchIndex) => {
        distributionClaims.push(
          Steps.contracts.sysio.dclaim.planImportSeedBatch<C>(
            Actor.Sysio,
            `import-dclaim-${chain}-${batchIndex + 1}`,
            `import ${chain} dclaim batch ${batchIndex + 1}/${chainResult.batches.length}`,
            {},
            chainResult.chain,
            batchIndex,
            batch.credits.length,
            {
              sources: chainResult.sources,
              eligibleAddressCount: chainResult.eligibleAddressCount,
              batchCount: chainResult.batches.length,
              totalAtomic: chainResult.totalAtomic.toString(),
              droppedDust: chainResult.droppedDust.toString()
            }
          )
        )
      })
    })
    if (bootstrap.chains.length > 0) {
      distributionClaims.push(
        Steps.contracts.sysio.dclaim.planImportDone<C>(
          Actor.Sysio,
          "finalize-dclaim-import",
          "close the dclaim import window",
          {}
        )
      )
    }

    // ── the bootstrap node owner (issues every subsequent resource policy) ──
    // Mirrors the OPP NFT-claim depot path (`newnameduser` + `nodeownreg`, the
    // SAME actions flow-node-owner-nft exercises) rather than the admin
    // `forcereg` shortcut. Registering at tier 1 allocates the ROA reserve
    // that `WireUserTool.provisionWireUser` (and every `addpolicy` issued as
    // `Constants.BOOTSTRAP_NODE_OWNER`) draws from.
    ClusterBuildPhase.create<C>(
      prerequisites,
      "BootstrapNodeOwner",
      "Create + register the bootstrap node owner"
    ).push(
      Steps.contracts.sysio.roa.planNewnameduser<C>(
        Actor.Sysio,
        "create-node-owner",
        `create ${Constants.BOOTSTRAP_NODE_OWNER} with pool-gifted RAM`,
        {},
        {
          account: Constants.BOOTSTRAP_NODE_OWNER,
          pubkey: Constants.DEV_K1_PUBLIC_KEY,
          tier: NodeOwnerTier.T1
        }
      ),
      Steps.contracts.sysio.roa.planNodeownreg<C>(
        Actor.Sysio,
        "register-node-owner",
        `register ${Constants.BOOTSTRAP_NODE_OWNER} at tier 1`,
        {},
        {
          owner: Constants.BOOTSTRAP_NODE_OWNER,
          tier: NodeOwnerTier.T1,
          eth_pub_key: AuthExLinkTool.newEthereumPubEm(),
          wire_pub_key: Constants.DEV_K1_PUBLIC_KEY
        }
      ),
      // nodeownreg SOFT-FAILS claim-payload problems into an audit row; a
      // silently-unregistered owner would otherwise surface much later as a
      // cryptic "Only Node Owners can issue policies" on the first addpolicy.
      verifyStep<C>(
        Actor.Sysio,
        "verify-node-owner",
        "the nodeowners row exists (else surface the audit rejection)",
        async ctx => {
          const registered = await readNodeOwner(
            ctx.wire,
            Constants.BOOTSTRAP_NODE_OWNER
          )
          if (registered == null) {
            const audit = await readNodeOwnerReg(
              ctx.wire,
              Constants.BOOTSTRAP_NODE_OWNER
            )
            Assert.fail(
              `bootstrap node owner ${Constants.BOOTSTRAP_NODE_OWNER} was not registered by nodeownreg` +
                (audit == null
                  ? " (no audit row found)"
                  : ` (rejected: status=${audit.status}, reason=${audit.reason})`)
            )
          }
        }
      )
    )

    // ── outpost deploys (own the run anvil + validator) — OR, in external mode,
    //    verify the already-running remote outpost endpoints instead ──
    if (isExternalOutpost) {
      ClusterBuildPhase.create<C>(
        prerequisites,
        "MaterializeExternalOutposts",
        "Materialize the external outpost artifacts + verify the endpoints"
      ).push(
        // REPLACES the omitted ETH/SOL deploy phases: copy the config-referenced
        // files into the canonical data dir so every downstream reader is unchanged.
        Steps.externalOutpost.planMaterialize<C>(
          Actor.Sysio,
          "materialize-external-artifacts",
          "copy the external-outpost config files into the canonical data dir",
          {}
        ),
        Steps.externalOutpost.planVerifyEthereumEndpoint<C>(
          Actor.EthereumOutpost,
          "verify-ethereum-endpoint",
          "the external Ethereum RPC reports the configured chain id",
          {}
        ),
        Steps.externalOutpost.planVerifySolanaEndpoint<C>(
          Actor.SolanaOutpost,
          "verify-solana-endpoint",
          "the external Solana RPC responds to getVersion",
          {}
        )
      )
    } else {
      ClusterBuildPhase.create<C>(
        prerequisites,
        "EthereumOutpost",
        "Deploy the Ethereum outpost"
      ).push(
        Steps.processes.anvil.planStart<C>(
          Actor.EthereumOutpost,
          "start-anvil",
          "start the run-time anvil (instamine)",
          {}
        ),
        Steps.ethereumOutpost.planDeploy<C>(
          Actor.EthereumOutpost,
          "deploy-ethereum",
          "deploy + seed the Ethereum outpost",
          { timeoutMs: 900_000 }
        ),
        Steps.processes.anvil.planEnableIntervalMining<C>(
          Actor.EthereumOutpost,
          "enable-interval-mining",
          "switch anvil to interval mining",
          {}
        )
      )
      ClusterBuildPhase.create<C>(
        prerequisites,
        "SolanaOutpost",
        "Deploy the Solana outpost"
      ).push(
        Steps.processes.solanaValidator.planStart<C>(
          Actor.SolanaOutpost,
          "start-validator",
          "start solana-test-validator + liqsol_core (OPP outpost)",
          {}
        ),
        Steps.solanaOutpost.planDeploy<C>(
          Actor.SolanaOutpost,
          "deploy-solana",
          "init PDAs + provision SPL reserves",
          { timeoutMs: 900_000 }
        )
      )
    }

    // ── registry + optional mock reserves + underwriter config ──
    ClusterBuildPhase.create<C>(
      prerequisites,
      "Registry",
      "Seed chains + tokens"
    ).push(
      Steps.registry.planSeedRegistry<C>(
        Actor.Sysio,
        "seed-registry",
        "register chains, tokens, chain-tokens",
        {}
      )
    )
    // Mock (chain, token) PRIMARY reserves — opt-in via `--enable-mock-reserves`
    // (default off, so a real / external depot never gets fake reserves). Seeded
    // HERE, pre-EpochBootstrap, because the contract gates `regreserve` to the
    // epoch-0 bootstrap window — a flow phase (which always runs after epoch
    // 0→1) could never seed them.
    if (config.enableMockReserves) {
      Steps.registry.planMockReserves<C>(
        prerequisites,
        "MockReserves",
        "Seed the 8 mock (chain, token) PRIMARY reserves",
        {}
      )
    }
    ClusterBuildPhase.create<C>(
      prerequisites,
      "UnderwriterConfig",
      "Configure sysio.uwrit"
    ).push(
      Steps.contracts.sysio.uwrit.planSetconfig<C>(
        Actor.Sysio,
        "configure-uwrit",
        "set the underwriter config",
        {},
        {
          fee_bps: SwapFeeBps,
          collateral_lock_duration_ms: CollateralLockDurationMs,
          min_fromwire_amount: MinFromWireAmount,
          fromwire_revert_fee_bps: FromWireRevertFeeBps
        }
      )
    )

    // ═══ Cluster Post Contract Deployment — batch/uw operators, nodes, first epoch ═══
    const postContractDeployment = ClusterBuildPhaseGroup.create<C>(
      cluster,
      "Cluster Post Contract Deployment",
      "Provision batch operators + underwriters, start operator nodes, bootstrap the first epoch"
    )

    // The operator daemons' shared prerequisites: the in-process OPP debugging
    // sink (external_debugging_plugin posts every envelope there) + the deploy
    // artifacts (ETH ABIs with addresses, SOL program id + IDL) their args reference.
    ClusterBuildPhase.create<C>(
      postContractDeployment,
      "OperatorDaemonPrerequisites",
      "Start the OPP debugging server + prepare daemon artifacts"
    ).push(
      Steps.processes.debuggingServer.planStart<C>(
        Actor.Sysio,
        "start-debugging-server",
        "start the in-process OPP debugging server",
        {}
      ),
      isExternalOutpost
        ? Steps.externalOutpost.planPublishArtifacts<C>(
            Actor.Sysio,
            "publish-external-artifacts",
            "publish ETH ABI + SOL IDL daemon artifacts from the external-outpost config",
            {}
          )
        : OperatorDaemonTool.planArtifactPreparation<C>(
            Actor.Sysio,
            "prepare-daemon-artifacts",
            "write ETH ABI + SOL IDL artifacts for operator daemons",
            {}
          )
    )

    // Bootstrapped batch operators + underwriters via the ONE mechanism (no funding —
    // deposit flows provision their own non-bootstrapped ops with funding).
    WireOperatorProvisioningTool.planOperatorAccountProvisioning<C>(
      postContractDeployment,
      "Create batchops & uws",
      "Provision the bootstrapped batch operators + underwriters",
      {},
      [
        ...batchOperators.map((label, index) => ({
          label,
          type: OperatorType.BATCH,
          ethereumHdIndex: index + 1,
          isBootstrapped: true,
          // Fee-payer funding for the daemon's per-epoch SOL deliveries (ETH
          // needs none — anvil prefunds the operator HD accounts).
          airdropSolanaLamports: BatchOperatorAirdropLamports
        })),
        ...underwriters.map((label, index) => ({
          label,
          type: OperatorType.UNDERWRITER,
          ethereumHdIndex: config.batchOperatorCount + index + 1,
          isBootstrapped: false
        }))
      ]
    )

    const operatorNodeGroup = ClusterBuildPhaseGroup.create<C>(
      postContractDeployment,
      "OperatorNodes",
      "Start operator nodes",
      { parallel: true }
    )
    NodeConfig.plan(config)
      .filter(node => node.role === NodeRole.operator)
      .forEach(node => {
        const actor =
          node.batchOperatorLabel != null
            ? Actor.BatchOperator
            : Actor.Underwriter
        ClusterBuildPhase.create<C>(
          operatorNodeGroup,
          node.name,
          `Start ${node.name}`
        ).push(
          Steps.processes.nodeop.planStart<C>(
            actor,
            `start-${node.name}`,
            `start ${node.name}`,
            {},
            node.name
          )
        )
      })

    // The underwriter_plugin defers its startup preflight until the chain
    // plugin reports the node synced (head within `sync_recency_ms` of now,
    // via the controller's accepted_block signal), so a first boot that
    // starts at genesis simply waits out its replay — no relaunch needed.
    // The generic `Steps.processes.nodeop.restart` machinery remains for
    // scenarios that need a real restart.

    // ── first epoch ──
    ClusterBuildPhase.create<C>(
      postContractDeployment,
      "EpochBootstrap",
      "Schedule groups + bootstrap epoch 0 → 1"
    ).push(
      Steps.contracts.sysio.epoch.planSchbatchgps<C>(
        Actor.Sysio,
        "schedule-batch-groups",
        "build the initial batch-operator schedule",
        {}
      ),
      Steps.contracts.sysio.msgch.planBootstrap<C>(
        Actor.Sysio,
        "bootstrap-epoch",
        "bootstrap the first epoch",
        { timeoutMs: 300_000 }
      )
    )

    // External-outpost success gate: no local chain to advance an epoch on, so
    // prove the depot is producing blocks (head advance) — plan §5.3.
    if (isExternalOutpost) {
      ClusterBuildPhase.create<C>(
        postContractDeployment,
        "HeadBlockAdvance",
        "Verify the depot head block advances (external-outpost success gate)"
      ).push(
        Steps.externalOutpost.planHeadBlockAdvance<C>(
          Actor.Sysio,
          "verify-head-advance",
          "the depot head block advances (external-outpost liveness)",
          {}
        )
      )
    }
  }

  async function loadConfiguredDistributionClaimBootstrap(
    config: ClusterConfig
  ): Promise<DistributionClaimBootstrapCore> {
    const configuredInputs: readonly ConfiguredDistributionClaimInput[] = [
      ...(config.ethereum.bootstrapJsonFile == null
        ? []
        : [
            {
              chain: ChainKind.EVM,
              file: config.ethereum.bootstrapJsonFile
            } satisfies ConfiguredDistributionClaimInput
          ]),
      ...(config.solana.bootstrapJsonFile == null
        ? []
        : [
            {
              chain: ChainKind.SVM,
              file: config.solana.bootstrapJsonFile
            } satisfies ConfiguredDistributionClaimInput
          ])
    ]
    const creditSets = await mapSeries(configuredInputs, async input => {
      const dump = await loadIndexBalanceDump(input.file, input.chain),
        conversion = convertImportSeedCredits(dump, input.chain)
      if (conversion.credits.length === 0) {
        throw new Error(
          `${distributionClaimChainLabel(input.chain)} bootstrap file ${JSON.stringify(input.file)} produced zero eligible credits`
        )
      }
      return {
        chain: input.chain,
        source: DistributionClaimBootstrapSource.configuredFile,
        credits: conversion.credits,
        droppedDust: conversion.droppedDust
      }
    })
    return { creditSets }
  }

  function logDistributionClaimBootstrap(
    log: Logger,
    result: ReturnType<typeof finalizeDistributionClaimBootstrap>
  ): void {
    if (result.chains.length === 0) {
      log.info(
        "[dclaim bootstrap] no credits supplied; import window remains open"
      )
      return
    }
    result.chains.forEach(chain => {
      log.info(
        `[dclaim bootstrap] ${distributionClaimChainLabel(chain.chain)} ` +
          `sources=${chain.sources.join(",")} addresses=${chain.eligibleAddressCount} ` +
          `batches=${chain.batches.length} totalAtomic=${chain.totalAtomic} ` +
          `droppedDust=${chain.droppedDust}`
      )
    })
  }

  function distributionClaimChainLabel(
    chain: ImportSeedChainKind
  ): DistributionClaimChainLabel {
    return chain === ChainKind.EVM
      ? DistributionClaimChainLabel.Ethereum
      : DistributionClaimChainLabel.Solana
  }

  /**
   * The `sysio.epoch::setconfig` data, derived from the batch-operator topology.
   *
   * The shape itself comes from {@link BatchOperatorSchedule.resolve} — the ONE
   * place it is derived and validated, shared with
   * `ClusterConfigProvider.resolve` so this step can never emit a shape the
   * CLI/flow boundary would have accepted differently (or vice versa).
   *
   * Exported (a pure value helper, not a Step) so the spec is unit-testable
   * without standing up a cluster.
   *
   * @param config - The resolved cluster config (topology + epoch overrides).
   * @returns The `epoch::setconfig` action data.
   * @throws If the resulting group shape violates the spec.
   */
  export function epochConfig(
    config: ClusterConfig
  ): SysioContracts.SysioEpochSetconfigAction {
    const { operatorsPerEpoch, batchOpGroups, batchOperatorMinimumActive } =
      BatchOperatorSchedule.resolve({
        batchOperatorCount: config.batchOperatorCount,
        operatorsPerEpoch: config.operatorsPerEpoch,
        batchOpGroups: config.batchOpGroups
      })
    return {
      epoch_duration_sec: config.epochDurationSec,
      operators_per_epoch: operatorsPerEpoch,
      batch_operator_minimum_active: batchOperatorMinimumActive,
      batch_op_groups: batchOpGroups,
      epoch_retention_envelope_log_count:
        config.epochRetentionEnvelopeLogCount ?? EnvelopeLogRetentionEpochs
    }
  }

  /**
   * The `sysio.opreg::setconfig` data — dev defaults + the config's per-type
   * collateral minimums (a flow's `defaults.requiredBatchOperatorCollateral` etc. flow through
   * here, gating `OPERATOR_STATUS_ACTIVE` on real deposits).
   */
  function operatorRegistryConfig(
    config: ClusterConfig
  ): SysioContracts.SysioOpregSetconfigAction {
    const toChainMinBond = (
      requirement: CollateralRequirement
    ): SysioContracts.SysioOpregChainMinBondType => ({
      chain_code: { value: requirement.chainCode },
      token_code: { value: requirement.tokenCode },
      min_bond: requirement.minimumBond,
      config_timestamp_ms: 0
    })
    return {
      max_available_producers: 21,
      max_available_batch_ops: 63,
      max_available_underwriters: 21,
      terminate_prune_delay_ms: 600_000,
      terminate_max_consecutive_misses:
        config.terminateMaxConsecutiveMisses ??
        DefaultTerminateMaxConsecutiveMisses,
      terminate_max_pct_misses_24h:
        config.terminateMaxPercentMisses24h ??
        DefaultTerminateMaxPercentMisses24h,
      terminate_window_ms: config.terminateWindowMs ?? DefaultTerminateWindowMs,
      req_prod_collat: config.requiredProducerCollateral.map(toChainMinBond),
      req_batchop_collat:
        config.requiredBatchOperatorCollateral.map(toChainMinBond),
      req_uw_collat: config.requiredUnderwriterCollateral.map(toChainMinBond)
    }
  }
}
