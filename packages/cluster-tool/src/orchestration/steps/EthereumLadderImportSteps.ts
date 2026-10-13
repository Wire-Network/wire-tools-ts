import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { range } from "lodash"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { SysioContracts } from "@wireio/sdk-core"
import type { OppSnapshot } from "capital-index/opp"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { ProtocolTiming } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { EthereumSyndicationTool } from "../../tools/ethereum/EthereumSyndicationTool.js"
import {
  convertImportSeed,
  serializeBatchForClio
} from "../../tools/wire/WireDclaimSeedTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { EthereumPreLaunchSteps } from "../ethereum/EthereumPreLaunchSteps.js"
import {
  CapitalIndexSnapshotKey,
  EthereumBookedFigureKey,
  EthereumLadderImportKey,
  EthereumLadderSummaryKey,
  type EthereumLadderImport
} from "../outputs/EthereumLadderOutput.js"
import type { StepInput } from "../StepRunner.js"
import { verifyStep } from "../StepTools.js"
import { DclaimContractSteps } from "./contracts/sysio/DclaimContractSteps.js"
import { LiqContractSteps } from "./contracts/sysio/LiqContractSteps.js"
import { SyndContractSteps } from "./contracts/sysio/SyndContractSteps.js"
import { MockShadowBackingSteps } from "./MockShadowBackingSteps.js"
import { RegistrySteps } from "./RegistrySteps.js"

const log = getLogger(__filename)

/** The capital-index snapshot library, typed from the package itself. */
type CapitalIndexModule = typeof import("capital-index/opp")

/** The one cached load of the library; see {@link importCapitalIndexModule}. */
let capitalIndexModule: Promise<CapitalIndexModule> | null = null

/**
 * Load `capital-index/opp` once, on first use. Only a ladder cluster takes the
 * snapshot, so the library (and the hashing it does at load) stays out of
 * every other consumer of the cluster-tool barrel — the jsdom-hosted QL app's
 * renderer tests among them, where its load-time topic hash rejects Node's
 * cross-realm `Buffer`. The promise is assigned synchronously, so concurrent
 * callers share the one import.
 */
function importCapitalIndexModule(): Promise<CapitalIndexModule> {
  return (capitalIndexModule ??= import("capital-index/opp"))
}

/**
 * The frozen pre-launch outpost imported into the depot during epoch zero,
 * through capital-index: its `OPPMessage` stream is read straight from the
 * cluster's anvil and replayed into staker and purchaser balances
 * (`buildOppSnapshot` — the same computation the production indexer serves),
 * then the booked figure the freeze recorded is reconciled against them:
 *
 * - `sysio.synd::importsynd` — one credit per staker, keyed by the compressed
 *   public key capital-index recovered from the staker's own transactions, in
 *   the depot's nine-decimal frame;
 * - `sysio.liq::regliqpool` — the Ethereum shadow's pool, its LCO shadow being
 *   the booked custody net of those credits (the purchase proceeds and the
 *   yield the pool already holds), so the depot's outstanding equals the
 *   custody the go-live seeds the pool with (invariant V13);
 * - `sysio.dclaim::importseed` — the purchasers' pretokens and the stakers'
 *   pretoken yield, through the same converter the launch import uses.
 *
 * Every write is its own Step; the snapshot and the derivation are a read
 * Step that publishes to `ctx.outputs`.
 */
export namespace EthereumLadderImportSteps {
  /** Where the snapshot lands in the cluster's deployments dir, for forensics. */
  export const SnapshotFile = "capital-index-snapshot.json"
  /** The first anvil block to scan; the whole chain is the ladder's. */
  export const SnapshotFromBlock = 0
  /** liqETH wei per depot base unit (18 minus 9 decimals). */
  export const WeiPerDepotUnit = MockShadowBackingSteps.EthereumWeiPerDepotUnit
  /** The outpost book key of the pre-launch OPP contract whose stream the snapshot reads. */
  export const OppContractName = "OPP"
  /** Read-step ceiling: a few hundred blocks of logs plus the stakers' transactions. */
  export const SnapshotStepOptions: ClusterBuildStepOptions = {
    timeoutMs: ProtocolTiming.OutpostWriteBudgetMs
  }

  /** Which credit a per-staker importsynd Step pushes. */
  export interface CreditInput extends StepInput {
    readonly kind: "EthereumLadderImportSteps.CreditInput"
    readonly creditIndex: number
  }

  /** Which dclaim batch an importseed Step pushes. */
  export interface SeedBatchInput extends StepInput {
    readonly kind: "EthereumLadderImportSteps.SeedBatchInput"
    readonly batchIndex: number
  }

  /** What a ladder cluster's mock flags add to the import phase. */
  export interface ImportOptions {
    /** Import the mock bonder's LIQSOL position too (the `enableMockSyndicationImport` flag on a ladder cluster). */
    readonly mockSolanaCredit: boolean
  }

  /**
   * The `importsynd` credits: one per staker with a recovered public key, the
   * net principal floored to the depot frame; zero credits are dropped. A
   * staker without a key cannot be imported (the depot parks credits against
   * the authex-linked pubkey), so the harness refuses rather than drop one.
   */
  export function syndicationCredits(
    snapshot: OppSnapshot
  ): SysioContracts.SysioSyndImportCreditType[] {
    return snapshot.stakers.flatMap(staker => {
      Assert.ok(
        staker.pubkey,
        `EthereumLadderImportSteps: staker ${staker.address} has no recovered public key; its position cannot be imported`
      )
      const amount = BigInt(staker.netPrincipal) / WeiPerDepotUnit
      return amount > 0n
        ? [{ pubkey: staker.pubkey.replace(/^0x/i, ""), amount: amount.toString() }]
        : []
    })
  }

  /** The booked figure (wei) in the depot's nine-decimal frame, floored. */
  export function bookedDepotUnits(bookedWei: bigint): bigint {
    return bookedWei / WeiPerDepotUnit
  }

  /**
   * `regliqpool`'s `initial_chain_amount`: the booked custody net of the
   * imported positions. The flooring dust of every credit lands here, so the
   * depot's outstanding equals the booked figure exactly.
   */
  export function initialChainAmount(
    booked: bigint,
    credits: readonly SysioContracts.SysioSyndImportCreditType[]
  ): bigint {
    const imported = credits.reduce((sum, credit) => sum + BigInt(credit.amount), 0n)
    Assert.ok(
      imported <= booked,
      `EthereumLadderImportSteps: the imported positions (${imported}) exceed the booked figure (${booked})`
    )
    return booked - imported
  }

  /** Derive the whole import from the snapshot and the booked figure. */
  export function deriveImport(
    snapshot: OppSnapshot,
    bookedWei: bigint
  ): EthereumLadderImport {
    const booked = bookedDepotUnits(bookedWei),
      credits = syndicationCredits(snapshot),
      seed = convertImportSeed(snapshot, { chain: ChainKind.EVM })
    return {
      bookedDepotUnits: booked,
      credits,
      initialChainAmount: initialChainAmount(booked, credits),
      importseed: seed.batches.map(serializeBatchForClio),
      importseedTotalAtomic: seed.totalAtomic
    }
  }

  /**
   * Compose the import: the snapshot, the Ethereum pool, one importsynd per
   * staker, the mock LIQSOL credit when the cluster asks for it, the seal,
   * the reconciliation verify, then the dclaim batches and their seal.
   */
  export function planImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    importOptions: ImportOptions
  ): ClusterBuildPhase<C> {
    const mockSolana = importOptions.mockSolanaCredit
      ? [
          RegistrySteps.planMockSyndicationBonder<C>(
            Report.Actor.Sysio,
            "materialize-mock-syndication-bonder",
            "persist the bonder's import keys",
            options
          ),
          RegistrySteps.planMockSyndicationCredit<C>(
            Report.Actor.Sysio,
            "import-syndication-liqsol",
            "import the mock bonder's LIQSOL position during epoch zero",
            options,
            RegistrySteps.MockSyndicationImportCredits.find(
              credit => credit.chain_code === RegistrySteps.SolanaChainCodename
            )
          )
        ]
      : []
    return ClusterBuildPhase.create<C>(parent, name, description, [
      planSnapshot<C>(
        Report.Actor.EthereumOutpost,
        "snapshot-capital-index",
        "replay the frozen outpost's OPP stream into balances and derive the import",
        SnapshotStepOptions
      ),
      planLiqPool<C>(
        Report.Actor.Sysio,
        "seed-liq-pool-ethereum-liqeth",
        "register the LIQETH/WIRE yield pool with the booked custody net of the imported positions",
        options
      ),
      ...range(EthereumPreLaunchSteps.StakerCount).map(creditIndex =>
        planImportsyndCredit<C>(
          Report.Actor.Sysio,
          `import-syndication-liqeth-${creditIndex}`,
          "import one frozen staker's position during epoch zero",
          options,
          creditIndex
        )
      ),
      ...mockSolana,
      SyndContractSteps.planImportdone<C>(
        Report.Actor.Sysio,
        "seal-syndication-import",
        "seal the bootstrap import",
        options,
        {}
      ),
      verifyStep<C>(
        Report.Actor.Sysio,
        "verify-ladder-import",
        "the depot's outstanding LIQETH equals the booked figure",
        assertOutstandingEqualsBooked,
        options
      ),
      planImportseedBatch<C>(
        Report.Actor.Sysio,
        "import-pretoken-seed-0",
        "seed the frozen purchasers' pretokens and the stakers' pretoken yield",
        options,
        0
      ),
      DclaimContractSteps.planImportdone<C>(
        Report.Actor.Sysio,
        "seal-pretoken-import",
        "seal the dclaim import",
        options
      )
    ])
  }

  /** Plan the snapshot read: capital-index against the cluster's anvil, then the derivation. */
  export function planSnapshot<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runSnapshot)
  }

  /** Named runner — build the snapshot, persist it, derive and publish the import. */
  export async function runSnapshot<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const summary = ctx.outputs.assert(EthereumLadderSummaryKey),
      bookedWei = ctx.outputs.assert(EthereumBookedFigureKey),
      oppAddress = summary.outpost[OppContractName]
    Assert.ok(oppAddress, "EthereumLadderImportSteps: the ladder's book names no OPP contract")
    const { buildOppSnapshot } = await importCapitalIndexModule(),
      build = await buildOppSnapshot({
        rpc: toURL(ctx.config.bind.anvil.port, toDialAddress(ctx.config.bind.anvil.address)),
        oppAddress,
        fromBlock: SnapshotFromBlock,
        warn: message => log.warn(`[capital-index] ${message}`)
      }),
      { snapshot } = build
    Fs.writeFileSync(
      Path.join(ClusterConfigProvider.ethereumDeploymentsPath(ctx.config), SnapshotFile),
      JSON.stringify(snapshot, null, 2)
    )
    const derived = deriveImport(snapshot, bookedWei)
    ctx.outputs.set(CapitalIndexSnapshotKey, snapshot)
    ctx.outputs.set(EthereumLadderImportKey, derived)
    StepExtraRecorder.note("capital-index snapshot", {
      blocks: [build.fromBlock, build.toBlock],
      assertions: build.assertions.length,
      stakers: snapshot.stakers.length,
      purchasers: snapshot.purchasers.length,
      totalLiqEthStaked: snapshot.metadata.totalLiqEthStaked,
      totalLiqEthPurchased: snapshot.metadata.totalLiqEthPurchased,
      bookedWei: bookedWei.toString(),
      bookedDepotUnits: derived.bookedDepotUnits.toString(),
      initialChainAmount: derived.initialChainAmount.toString(),
      credits: derived.credits,
      importseedTotalAtomic: derived.importseedTotalAtomic.toString()
    })
  }

  /** Plan the Ethereum pool's registration with the derived shadow seed. */
  export function planLiqPool<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runLiqPool)
  }

  /** Named runner — ONE `regliqpool`, its `initial_chain_amount` from the derived import. */
  export async function runLiqPool<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    const derived = ctx.outputs.assert(EthereumLadderImportKey)
    await LiqContractSteps.runRegliqpool(
      ctx,
      {
        kind: "LiqContractSteps.RegliqpoolInput",
        data: RegistrySteps.liqPoolRegistration(
          RegistrySteps.EthereumChainCodename,
          RegistrySteps.EthereumLiqTokenCodename,
          derived.initialChainAmount.toString()
        )
      },
      signal
    )
  }

  /** Plan one staker's `importsynd`. */
  export function planImportsyndCredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    creditIndex: number
  ): ClusterBuildStep<C, CreditInput> {
    return ClusterBuildStep.create<C, CreditInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumLadderImportSteps.CreditInput", creditIndex },
      runImportsyndCredit
    )
  }

  /** Named runner — ONE `importsynd` carrying the indexed credit. */
  export async function runImportsyndCredit<C extends ClusterBuildContext>(
    ctx: C,
    input: CreditInput,
    signal: AbortSignal
  ): Promise<void> {
    const { credits } = ctx.outputs.assert(EthereumLadderImportKey),
      credit = credits[input.creditIndex]
    Assert.ok(
      credit != null,
      `EthereumLadderImportSteps: no credit ${input.creditIndex}; the snapshot yielded ${credits.length}`
    )
    await SyndContractSteps.runImportsynd(
      ctx,
      {
        kind: "SyndContractSteps.ImportsyndInput",
        data: {
          chain_code: RegistrySteps.EthereumChainCodename,
          token_code: RegistrySteps.EthereumLiqTokenCodename,
          credits: [credit]
        }
      },
      signal
    )
  }

  /** Plan one dclaim `importseed` batch. */
  export function planImportseedBatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchIndex: number
  ): ClusterBuildStep<C, SeedBatchInput> {
    return ClusterBuildStep.create<C, SeedBatchInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumLadderImportSteps.SeedBatchInput", batchIndex },
      runImportseedBatch
    )
  }

  /** Named runner — ONE `importseed` carrying the indexed batch; the ladder's actors fit one. */
  export async function runImportseedBatch<C extends ClusterBuildContext>(
    ctx: C,
    input: SeedBatchInput,
    signal: AbortSignal
  ): Promise<void> {
    const { importseed } = ctx.outputs.assert(EthereumLadderImportKey)
    Assert.strictEqual(
      importseed.length,
      input.batchIndex + 1,
      `EthereumLadderImportSteps: the snapshot yielded ${importseed.length} dclaim batches; one Step is planned per batch`
    )
    await DclaimContractSteps.runImportseed(
      ctx,
      { kind: "DclaimContractSteps.ImportseedInput", data: importseed[input.batchIndex] },
      signal
    )
  }

  /** The depot's outstanding LIQETH (shadow supply plus pending) equals the booked figure. */
  export async function assertOutstandingEqualsBooked<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<void> {
    const derived = ctx.outputs.assert(EthereumLadderImportKey),
      outstanding = await WireSyndicationTool.readOutstanding(
        ctx,
        RegistrySteps.EthereumLiqTokenCodename
      )
    StepExtraRecorder.note("ladder import reconciliation", {
      outstanding: outstanding.toString(),
      bookedDepotUnits: derived.bookedDepotUnits.toString(),
      initialChainAmount: derived.initialChainAmount.toString(),
      credits: derived.credits.length
    })
    Assert.strictEqual(
      outstanding,
      derived.bookedDepotUnits,
      "EthereumLadderImportSteps: the depot's outstanding LIQETH is not the booked figure"
    )
  }

  /** After the go-live: the pool's seeded principal is the booked figure, which the depot's outstanding also is. */
  export async function assertPoolSeededFromBooked<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<void> {
    const derived = ctx.outputs.assert(EthereumLadderImportKey),
      principal = await EthereumSyndicationTool.readSyndicatedPrincipal(ctx),
      outstanding = await WireSyndicationTool.readOutstanding(
        ctx,
        RegistrySteps.EthereumLiqTokenCodename
      )
    StepExtraRecorder.note("go-live reconciliation", {
      poolSyndicatedPrincipal: principal.toString(),
      depotOutstanding: outstanding.toString(),
      bookedDepotUnits: derived.bookedDepotUnits.toString()
    })
    Assert.strictEqual(
      principal,
      derived.bookedDepotUnits,
      "EthereumLadderImportSteps: SyndicationPool's principal is not the booked figure"
    )
    Assert.strictEqual(
      outstanding,
      principal,
      "EthereumLadderImportSteps: the depot's outstanding LIQETH differs from the pool's principal"
    )
  }
}
