import Assert from "node:assert"

import { LAMPORTS_PER_SOL } from "@solana/web3.js"
import { range } from "lodash"

import {
  SignatureProviderType,
  type ClusterConfig,
  type CollateralRequirement
} from "@wireio/cluster-tool-shared"
import {
  ChainKind,
  NodeOwnerTier,
  OperatorType
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { Constants, ProtocolTiming } from "../Constants.js"
import { BatchOperatorSchedule } from "../config/BatchOperatorSchedule.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { DaemonConfig } from "../config/DaemonConfig.js"
import { NodeConfig, NodeRole, producerName } from "../config/NodeConfig.js"
import { getLogger, type Logger } from "../logging/Logger.js"
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
import { pollUntil, verifyStep } from "./StepTools.js"

const log = getLogger(__filename)

const { SysioContractName } = SysioContracts
const { DeployMode } = ContractSteps
const { Actor } = Report

/**
 * Epoch index the LOCAL bootstrap gate waits for. `sysio.msgch::bootstrap`
 * takes the chain 0 → 1 inline, so reaching 2 is the first index that can only
 * come from `sysio.epoch::advance` firing on its own cadence — i.e. the depot
 * is circulating epochs, not merely bootstrapped.
 */
const EpochAdvanceTargetIndex = 2

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
 * routed like the settlement fee. Mirrors the contract default — the 5% launch
 * value — so a cluster prices revert churn the way the network will. Happy-path
 * flows never pay it and system-caused reverts refund in full, so no flow's
 * economics depend on this number.
 */
const FromWireRevertFeeBps = 500
/**
 * Nodeop processes started concurrently within a node-start group.
 *
 * Node starts are bounded — NOT unbounded — because every node joins the same
 * p2p mesh and begins syncing the moment it comes up. Starting a whole wave at
 * once (43 nodes landed within 6ms at a 21-producer topology) starves the
 * producers' vote propagation: QCs stop forming, LIB freezes while head keeps
 * advancing, and the next `pushActionAndWait` at irreversible finality hangs
 * until its transaction expires. Raising this trades bootstrap wall-clock for
 * that risk.
 */
const NodeStartConcurrency = 4
/**
 * Epochs a PENDING uwreq may wait for its underwriter race before
 * `sysio.uwrit::pruneuwreqs` expires it (refund/revert + EXPIRED). Mirrors
 * the contract default; flow races resolve within an epoch, so the timeout
 * only fires for genuinely abandoned requests (SEC-129 / WSA-223).
 */
const UwreqPendingTimeoutEpochs = 10
/**
 * Epochs a terminal (COMPLETED / REJECTED / EXPIRED) uwreq row is retained
 * for audit before `sysio.uwrit::pruneuwreqs` erases it. Mirrors the
 * contract default (SEC-129 / WSA-223).
 */
const UwreqRetentionEpochs = 10
/**
 * Stage 2 of the swap-fee split: the share of each fee's rewards pool routed to
 * the `sysio` emissions treasury instead of the batch-operator rewards bucket.
 * Mirrors `sysio.reserv::DEFAULT_FEE_EMISSIONS_SHARE_BPS`.
 *
 * Zero keeps every swap fee inside `sysio.reserv` custody at settlement (the
 * underwriter half as a `uwfees` accrual, the rest in the rewards bucket), which
 * is what the swap flows' custody assertions expect. Raising it makes exactly
 * that share leave custody per settlement.
 */
const FeeEmissionsShareBps = 0

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

/** Wei per ether — the ETH counterpart of `LAMPORTS_PER_SOL`. */
const WeiPerEther = 10n ** 18n

/**
 * Wei seeded into each bootstrapped operator's ETH wallet under SSM — the exact
 * ETH analogue of {@link BatchOperatorAirdropLamports}: their daemons PAY the gas
 * on every outbound delivery to the Ethereum outpost, every epoch, for the whole
 * run.
 *
 * Only needed under SSM. Under KEY the operator EM keys derive from
 * `EthereumOutpostBootstrapper.AnvilMnemonic`, whose HD accounts anvil prefunds;
 * under SSM they derive from a GENERATED cluster mnemonic (`KeySteps.ethereumMnemonic`)
 * that anvil has never heard of, so every wallet starts at ZERO.
 *
 * An unfunded fee payer does not fail loudly — the daemon's outbound tx is rejected
 * by the RPC with `-32003 'Out of gas: gas required exceeds allowance: 0'`, the ETH
 * outpost's `latestOutboundEnvelope` is never written, the depot reads back
 * `epoch_=0` forever, and the epoch stalls at 1 with SOL circulating normally
 * (measured 2026-08-04: 98 such rejections, all EVM, zero SVM).
 *
 * Sized as a GAS budget, never collateral — the bootstrap performs no ETH
 * collateral deposits for these operators.
 */
const BatchOperatorEthereumFundingWei = 10n * WeiPerEther

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
      await prepareDistributionClaimBootstrap?.(cluster, core)
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
      // Seeded by `ClusterBuild.create` from
      // `ClusterConfigProvider.resolveWithBiosKeys` — its `wire` key IS the
      // bootstrap node owner's account authority.
      nodeOwner = cluster.context.keyStore.assertOperator(
        Constants.BOOTSTRAP_NODE_OWNER
      ),
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
    // SSM mode: publish the node signing keys BEFORE any node consumes them — a
    // node's `--signature-provider ...SSM:` spec fetches its private key from
    // SSM at nodeop startup, so publication must precede the BiosNode AND
    // ProducerNodes starts. Under SSM the bios node is NOT exempt: its genesis
    // keys are generated (or adopted) at config resolution like any other node
    // key and its specs render `SSM:` too — only KEY / KIOD keep the inline
    // dev-key spec.
    if (config.signatureProvider.type === SignatureProviderType.SSM) {
      Steps.keys.planSignatureProviderKeyPublications<C>(
        prerequisites,
        "PublishNodeSignatureProviderKeys",
        "Publish the genesis + producer-node signing keys to AWS SSM",
        {},
        config,
        Steps.keys.SignatureKeyPublishPhase.beforeNodes
      )
    }
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
      { parallel: true, concurrency: NodeStartConcurrency }
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
      // The hosting node comes from `NodeConfig.plan` — the ONE author of the
      // producer→node assignment. Re-deriving `index % producerNodeCount` here
      // made a second copy that had to agree with it by hand.
      producerNodes.flatMap(node =>
        node.producers.map(label => ({
          label,
          type: OperatorType.PRODUCER,
          producerNodeIndex: node.index,
          producerNodeName: node.name
        }))
      )
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
      // Anchors node-owner vesting. Without it every `claimnodedis` aborts with
      // "emission state not initialized", so node owners register successfully but can
      // never claim. Reads the emission config, so it must follow `set-emit-config`.
      Steps.contracts.sysio.system.planSetinittime<C>(
        Actor.Sysio,
        "set-node-rewards-start",
        "anchor node-owner vesting at chain head time",
        {}
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
          // The account AUTHORITY — `newnameduser` sets this as the new
          // account's owner/active key, and every subsequent action signed as
          // BOOTSTRAP_NODE_OWNER (`roa::newuser` for every operator account,
          // `roa::addpolicy`) is authorized by it. Its private half is imported
          // into the kiod wallet by `KeySteps.runCreateWallet`.
          pubkey: nodeOwner.wire.publicKey,
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
          // NOT a free-form payload field: `sysio.roa::nodeownreg` runs
          // `active_key_matches(owner, wire_pub_key)` and soft-fails the claim
          // with ACCOUNT_KEY_MISMATCH (a REJECTED audit row, no revert) unless
          // this key can satisfy the account's `active` authority BY ITSELF —
          // i.e. it must be exactly the `newnameduser.pubkey` above.
          wire_pub_key: nodeOwner.wire.publicKey
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
          fromwire_revert_fee_bps: FromWireRevertFeeBps,
          uwreq_pending_timeout_epochs: UwreqPendingTimeoutEpochs,
          uwreq_retention_epochs: UwreqRetentionEpochs
        }
      )
    )
    ClusterBuildPhase.create<C>(
      prerequisites,
      "ReserveConfig",
      "Configure sysio.reserv fee routing"
    ).push(
      Steps.contracts.sysio.reserv.planSetconfig<C>(
        Actor.Sysio,
        "configure-reserv",
        "set the swap-fee routing config",
        {},
        { fee_emissions_share_bps: FeeEmissionsShareBps }
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

    // Bootstrapped batch operators + underwriters via the ONE mechanism. Fee-payer
    // funding only — deposit flows provision their own non-bootstrapped ops with
    // collateral funding on top.
    const isSSM = config.signatureProvider.type === SignatureProviderType.SSM
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
          // Fee-payer funding for the daemon's per-epoch deliveries on BOTH
          // chains. ETH is SSM-only: under KEY the EM keys come off the anvil
          // mnemonic and are prefunded, under SSM they come off a generated
          // mnemonic anvil never funded. See BatchOperatorEthereumFundingWei.
          airdropSolanaLamports: BatchOperatorAirdropLamports,
          ...(isSSM ? { fundEthereumWei: BatchOperatorEthereumFundingWei } : {})
        })),
        ...underwriters.map((label, index) => ({
          label,
          type: OperatorType.UNDERWRITER,
          ethereumHdIndex: config.batchOperatorCount + index + 1,
          isBootstrapped: false,
          ...(isSSM ? { fundEthereumWei: BatchOperatorEthereumFundingWei } : {})
        }))
      ]
    )

    // SSM mode: publish the just-provisioned operator keys BEFORE the operator
    // daemons start — their wire/ethereum/solana `--signature-provider ...SSM:`
    // specs fetch the private keys from SSM at nodeop startup.
    if (config.signatureProvider.type === SignatureProviderType.SSM) {
      Steps.keys.planSignatureProviderKeyPublications<C>(
        postContractDeployment,
        "PublishOperatorSignatureProviderKeys",
        "Publish each operator signing key to AWS SSM",
        {},
        config,
        Steps.keys.SignatureKeyPublishPhase.afterOperators
      )
    }

    const operatorNodeGroup = ClusterBuildPhaseGroup.create<C>(
      postContractDeployment,
      "OperatorNodes",
      "Start operator nodes",
      { parallel: true, concurrency: NodeStartConcurrency }
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

    // Bootstrap success gate. LOCAL mode watches the depot's own epoch advance
    // past the bootstrap epoch; EXTERNAL mode has no local chain to advance an
    // epoch on, so it proves the depot is producing blocks (head advance) AND
    // that the bootstrap actually queued an outbound envelope for every
    // registered outpost.
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
      ClusterBuildPhase.create<C>(
        postContractDeployment,
        "OutboundEnvelopesQueued",
        "Verify an outbound envelope is queued per registered outpost (external-outpost OPP gate)"
      ).push(
        Steps.externalOutpost.planOutboundEnvelopesQueued<C>(
          Actor.Sysio,
          "verify-outbound-envelopes",
          "every registered outpost has a queued outbound envelope",
          { timeoutMs: Steps.externalOutpost.OutboundEnvelopesTimeoutMs }
        )
      )
    } else {
      ClusterBuildPhase.create<C>(
        postContractDeployment,
        "EpochAdvance",
        "Verify the depot advances past the bootstrap epoch"
      ).push(
        verifyStep<C>(
          Actor.Sysio,
          "verify-epoch-advance",
          `sysio.epoch current_epoch_index reaches ${EpochAdvanceTargetIndex}`,
          runEpochAdvance
        )
      )
    }

    planStartScripts<C>(postContractDeployment, config)
  }

  /**
   * Emit each daemon's `start.sh` — ONE step per daemon, never one step looping
   * over N, so the Report validates every script individually.
   *
   * Placed LAST in the bootstrap: an operator node's argv includes its OPP
   * daemon args, which resolve from `OperatorDaemonArtifactsKey` — asserting
   * that output before the outpost deploys have published it would throw.
   *
   * @param parent - The phase group to register the phase on.
   * @param config - The resolved cluster config (which daemons exist).
   */
  function planStartScripts<C extends ClusterBuildContext>(
    parent: ClusterBuildPhaseGroup<C>,
    config: ClusterConfig
  ): void {
    // The daemon SET comes from DaemonConfig — never re-derived here, or the
    // emit labels and the enumeration can drift. That includes the bundle
    // gate: it reads the LABELS, so "is a debugging-server start.sh emitted?"
    // and "is its bundle copied?" are one predicate. Re-deriving the flag
    // would let `plannedLabels` gain a condition the copy step never learns,
    // emitting a script that execs a binary nobody copied.
    const labels = DaemonConfig.plannedLabels(config),
      debuggingServerEnabled = labels.includes(
        DaemonConfig.DebuggingServerSubpath
      ),
      phase = ClusterBuildPhase.create<C>(
        parent,
        "StartScripts",
        "Bundle the debugging server + emit a start.sh for every daemon"
      )
    // The bundle copy precedes the scripts: the server's start.sh lives in the
    // directory this step creates. Skipped wholesale when the server is
    // disabled — shipping 15 MB for a server that never runs is waste.
    if (debuggingServerEnabled)
      phase.push(
        Steps.debuggingServerBundle.planCopy<C>(
          Actor.Sysio,
          "copy-debugging-server-bundle",
          "copy the bundled debugging server into the cluster tree",
          {}
        )
      )
    Steps.startScript.planPhase<C>(phase, labels)
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
   * The epoch-advance gate's budget — {@link ProtocolTiming.EpochVerifyEpochCount}
   * effective-epoch windows, the SAME envelope `ClusterManager.run`'s post-relaunch
   * liveness check uses (one constant, two call sites; no new literal).
   *
   * @param config - The resolved cluster config (its `epochDurationSec`).
   * @returns The budget in ms.
   */
  export function epochAdvanceBudgetMs(config: ClusterConfig): number {
    return (
      ProtocolTiming.EpochVerifyEpochCount *
      ProtocolTiming.effectiveEpochSec(config.epochDurationSec) *
      ProtocolTiming.MsPerSecond
    )
  }

  /**
   * Named runner — poll `sysio.epoch::epochstate` until the depot has advanced
   * PAST the bootstrap epoch. `msgch::bootstrap` takes the chain 0 → 1 inline;
   * reaching {@link EpochAdvanceTargetIndex} proves `sysio.epoch::advance` then
   * fired on its own cadence, i.e. OPP is circulating and not merely bootstrapped.
   *
   * The poll owns the whole budget (no step ceiling), mirroring
   * `ExternalOutpostSteps.runHeadBlockAdvance` — one owner, so the Report carries
   * `pollUntil`'s precise timeout message rather than a racing step abort.
   *
   * @param ctx - The build context.
   * @param signal - Abort signal.
   */
  export async function runEpochAdvance<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pollUntil(
      `sysio.epoch current_epoch_index reaches ${EpochAdvanceTargetIndex}`,
      async () => {
        try {
          const { rows } = await ctx.wire.getEpochState()
          return (rows[0]?.current_epoch_index ?? 0) >= EpochAdvanceTargetIndex
        } catch (error) {
          log.debug(
            `[cluster] epoch-state read transient: ${error instanceof Error ? error.message : String(error)}`
          )
          return false
        }
      },
      epochAdvanceBudgetMs(ctx.config),
      ProtocolTiming.EpochVerifyPollIntervalMs
    )
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
