import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import {
  KeyType,
  PrivateKey,
  PublicKey,
  SlugName,
  SysioContracts
} from "@wireio/sdk-core"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { keyPairFromPrivate, solanaKeypair } from "../../utils/keyPairUtils.js"
import type { StepInput } from "../StepRunner.js"
import {
  MockSyndicationBonderKey,
  type MockSyndicationBonderOutput
} from "../outputs/MockSyndicationBonderOutput.js"
import { KeySteps } from "./KeySteps.js"
import { eachSeries } from "../../utils/asyncUtils.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { Constants, ProtocolTiming } from "../../Constants.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { ContractSteps } from "./ContractSteps.js"
import { BondContractSteps } from "./contracts/sysio/BondContractSteps.js"
import { KickerContractSteps } from "./contracts/sysio/KickerContractSteps.js"
import { LiqContractSteps } from "./contracts/sysio/LiqContractSteps.js"
import { SyndContractSteps } from "./contracts/sysio/SyndContractSteps.js"
import { SyndicationUserSteps } from "./SyndicationUserSteps.js"
import { OperatorDaemonArtifactsKey } from "../outputs/OperatorDaemonArtifacts.js"

const {
  SysioContractAccount,
  SysioContractName,
  SysioChainsChainkind,
  SysioTokensTokenkind,
  SysioTokensChainkind
} = SysioContracts

/**
 * Seeds the depot registry (`sysio.chains` chains, `sysio.tokens` tokens +
 * chain-token bindings). This is ONE composed step because most rows are
 * runtime-artifact-dependent — the ERC-20 / SPL / LIQ addresses come from the
 * outpost deploy artifacts (`outpost-addrs.json`, `liqeth-addrs.json`,
 * `sol-mock-mints.json`) that only exist after the outpost deploy runs, so the
 * rows cannot be static per-entry steps.
 *
 * The mock (chain, token) PRIMARY reserves are seeded SEPARATELY, by the
 * {@link RegistrySteps.planMockReserves} phase — their rows ARE fully static, so
 * each is its own Report-validated `regreserve` step, gated behind
 * `--enable-mock-reserves` (default off; the contract gates `regreserve` to the
 * bootstrap epoch-0 window, so the phase only ever runs pre-EpochBootstrap).
 */
export namespace RegistrySteps {
  /** Registry identity of Ethereum's liquid token, whose rebases can temporarily reduce custody. */
  const LiqEthCodename = "LIQETH"
  /** LIQETH's inclusive temporary custody-loss allowance (1%); all other pairs require full backing. */
  export const LiqEthCustodyShortfallBps = 100
  /**
   * Mock yield-pool parameters, per pool. The two seeds mirror the dev bootstrap
   * config (`etc/config/dex/dex-config.dev.json`); the 30 s horizon and the fee
   * are the dev cluster's own, so a flow's reported yield sells in ONE tick
   * instead of a day-long drip.
   */
  const MockLiqPoolShadowSeed = 10_000_000_000
  /** WIRE (9-dec base units) the system account seeds each mock pool with. */
  const MockLiqPoolWireSeed = 10_000_000_000
  /**
   * Swap fee of each mock pool, per ten-thousand (5 %), well above the dev config's
   * 0.30 % because it also bounds the clip cap: 5 % of the 10-token shadow side
   * sells a flow's reported yield (a 0.3-token donation plus staking yield) at once.
   */
  const MockLiqPoolFee = 500
  /** Pair-token shares locked at each mock pool's creation. */
  const MockLiqPoolLockedShares = 0
  /** Seconds over which a mock pool's reservoir is time-shared into clips. */
  const MockLiqPoolConversionHorizonSec = 30
  /**
   * Ceiling of one clip as bps of the pool's shadow depth: the fee, the widest
   * `sysio.swap::setyield` accepts, since a clip wider than the fee is worth
   * sandwiching.
   */
  const MockLiqPoolDepthCapBps = MockLiqPoolFee
  /** Smallest clip (shadow base units) a mock pool sells. */
  const MockLiqPoolClipFloor = 1000
  /**
   * `sysio.bond`'s hold bond, in basis points of a request's covered amount — the
   * contract's own default, set explicitly so the bootstrap states it.
   */
  export const BondHoldBps = 1000
  /**
   * Fee on each released syndication tranche (bps). The bootstrap charges none: the
   * only fee planned is on desyndication. A flow that exercises the syndication fee
   * path sets its own through `sysio.synd::setconfig` in its scenario and restores this.
   */
  export const SyndicationFeeBps = 0
  /**
   * Syndication is free. Desyndication takes floor(quantity * 5 / 10000) plus
   * the pair's flat fee to recover external-chain gas for BOTH round-trip legs.
   * A lone Ethereum round trip measured about 507k gas; Solana measured
   * 9k–104k lamports. Break-even sizing assumes syndicating min_desyndicate.
   * Each flat fee must remain strictly below its pair's min_desyndicate.
   */
  export const DesyndicationFeeBps = 5
  /** Flat return charge in depot base units (9 decimals), by shadow token. */
  export const DesyndicationFlatFees = {
    LIQETH: 5_000_000,
    LIQSOL: 100_000
  } as const
  /** Gross return floors in depot base units (9 decimals), by shadow token. */
  export const MinimumDesyndications = {
    LIQETH: 100_000_000,
    LIQSOL: 50_000_000
  } as const
  /**
   * Size and per-epoch refill of each pair's syndication and desyndication buckets
   * (shadow base units): one million tokens at the depot's 9 decimals, far above any
   * amount a flow moves, so no existing flow waits on a bucket.
   */
  export const SyndicationBucketSize = 1_000_000_000_000_000
  /** Bounty posted on each envelope's `sysio.bond` request (shadow base units): none. */
  export const SyndicationBounty = 0
  /**
   * Charged to a challenger on top of the hold bond (shadow base units): one token. The
   * contract refuses a challenge whose charge is zero, so this is never 0.
   */
  export const SyndicationChallengeExtra = 1_000_000_000

  /**
   * `sysio.kicker`'s governance earmark on the cluster (WIRE base units): one million
   * WIRE. `setconfig` REPLACES the remaining budget; the draw is further capped by the
   * treasury balance net of pending emissions, unclaimed pay and the remaining emission
   * ceiling, which on the cluster leaves hundreds of millions of WIRE free, so this
   * earmark is what bounds the gifts. Changing it changes how much a flow can draw.
   */
  export const KickerBudget = 1_000_000_000_000_000
  /**
   * `sysio.kicker`'s minimum unpaid interval on the cluster (s): one minute, the
   * `sysio.epoch` duration floor, so a flow sees a payable interval within an epoch.
   * The contract's own default is one hour (`kicker_math::default_min_interval_sec`);
   * a real depot sets its interval by governance, and on a real depot it is a floor
   * on keeper cadence, not a schedule.
   */
  export const KickerMinIntervalSec = 60
  /** Each LIQ token's annual simple rate (bps): the contract default, 2 %. */
  export const KickerRateBps = 200
  /**
   * Each LIQ token's minimum gift (WIRE base units): the contract default, one WIRE.
   * At the mock pools' 10-token supply the gift accrues ~0.2 WIRE a year, so no kick
   * pays at this minimum; a flow that exercises a payment lowers it with `setpool`
   * and restores this value.
   */
  export const KickerMinGift = 1_000_000_000
  /** Each LIQ token's mandatory daily spend ceiling: 1,000 WIRE in base units. */
  export const KickerMaxGiftPerDay = 1_000_000_000_000
  /** Governance TWAP window (s): the contract default, one day. */
  export const KickerTwapWindowSec = 86_400
  /**
   * Governance spot-deviation guard (bps): the contract default, 50 %. A kick whose
   * pool spot price sits further than this from its TWAP pays nothing and flags the
   * pool's `spot_deviation`. Raising it admits more manipulated prices; lowering it
   * skips more honest kicks after a large trade. `setconfig` accepts 1 through 10,000.
   */
  export const KickerMaxSpotDeviationBps = 5_000

  /** Durable bonder identity; flows resolve its ED/EM keys from readMockSyndicationBonder. */
  export const MockSyndicationBonderLabel = "mock-syndication-bonder"
  /** Beyond all funded anvil/operator slots; the import needs no outpost transaction. */
  export const MockSyndicationBonderEthereumHdIndex = AnvilProcess.AccountCount
  /** One hundred tokens per imported position, in the depot's nine-decimal frame. */
  export const MockSyndicationImportAmount = 100_000_000_000

  /** Runtime key selection plus the generated import action's pair and credit amount. */
  export interface MockSyndicationImportInput
    extends
      StepInput,
      Pick<SysioContracts.SysioSyndImportsyndAction, "chain_code">,
      Pick<SysioContracts.SysioSyndImportsyndAction, "token_code">,
      Pick<SysioContracts.SysioSyndImportCreditType, "amount"> {
    readonly kind: "RegistrySteps.MockSyndicationImportInput"
    readonly keyType: KeyType.ED | KeyType.EM
  }

  /** Import templates; public keys resolve only after the bonder materializes. */
  export const MockSyndicationImportCredits: MockSyndicationImportInput[] = [
    {
      kind: "RegistrySteps.MockSyndicationImportInput",
      chain_code: Constants.SOLANA_CHAIN_CODENAME,
      token_code: Constants.LIQSOL_CODENAME,
      keyType: KeyType.ED,
      amount: MockSyndicationImportAmount
    },
    {
      kind: "RegistrySteps.MockSyndicationImportInput",
      chain_code: Constants.ETHEREUM_CHAIN_CODENAME,
      token_code: "LIQETH",
      keyType: KeyType.EM,
      amount: MockSyndicationImportAmount
    }
  ]

  /**
   * The one import credit template signed by `keyType`, refusing none or several.
   *
   * @param keyType - The key the template's credits are imported to.
   * @return The template.
   */
  export function assertImportCredit(
    keyType: MockSyndicationImportInput["keyType"]
  ): MockSyndicationImportInput {
    const credits = MockSyndicationImportCredits.filter(
      input => input.keyType === keyType
    )
    Assert.strictEqual(
      credits.length,
      1,
      `mock syndication import has ${credits.length} ${KeyType[keyType]} credits, expected one`
    )
    return credits[0]
  }

  /**
   * The template an underwriting batch operator's credit copies: the ED-keyed (Solana)
   * position, since the credit is imported to the operator's own ED key. Its `token_code` is
   * the shadow the operator bonds from and its `amount` what it holds — the mock bonder's
   * one hundred tokens, which must exceed the operators' exposure cap for the cap to bind.
   */
  export const MockBatchOperatorUnderwritingPair = assertImportCredit(
    KeyType.ED
  )

  /**
   * Provision the import identity, import each position separately, then seal import.
   *
   * @param batchOperatorLabels - Batch operators that underwrite
   *   and are funded (`batchOperatorUnderwriting.fundedOperatorCount`): each also gets a
   *   credit for each shadow to its own matching ED/EM key, imported
   *   before the seal. Their identities must already be in `ctx.keyStore`, so a caller passing
   *   any plans this phase after operator provisioning. Empty by default.
   */
  export function planMockSyndicationImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperatorLabels: readonly string[] = []
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(parent, name, description, [
      planMockSyndicationBonder<C>(
        Report.Actor.Sysio,
        "materialize-mock-syndication-bonder",
        "persist the bonder's import keys",
        options
      ),
      ...MockSyndicationImportCredits.map(input =>
        planMockSyndicationCredit<C>(
          Report.Actor.Sysio,
          `import-syndication-${input.token_code.toLowerCase()}`,
          "import one bonder position during epoch zero",
          options,
          input
        )
      ),
      ...batchOperatorLabels.flatMap(label =>
        MockSyndicationImportCredits.map(credit =>
          planBatchOperatorSyndicationCredit<C>(
            Report.Actor.Sysio,
            `import-underwriting-${label}-${credit.token_code.toLowerCase()}`,
            `import ${label}'s underwriting ${credit.token_code} to its own linked key during epoch zero`,
            options,
            label,
            credit.keyType
          )
        )
      ),
      SyndContractSteps.planImportdone<C>(
        Report.Actor.Sysio,
        "seal-mock-syndication-import",
        "seal the bootstrap import",
        options,
        {}
      ),
      planVerifyMockSyndicationImport<C>(
        Report.Actor.Sysio,
        "verify-mock-syndication-import",
        "both bonder credits are parked, every underwriting operator holds its credit, and no custody mismatch exists",
        options,
        batchOperatorLabels
      )
    ])
  }

  /** Input for {@link planBatchOperatorSyndicationCredit}. */
  export interface BatchOperatorCreditInput extends StepInput {
    readonly kind: "RegistrySteps.BatchOperatorCreditInput"
    /** The batch operator's durable handle in `ctx.keyStore`. */
    readonly label: string
    /** Curve selecting the shadow and the operator's linked outpost key. */
    readonly keyType: MockSyndicationImportInput["keyType"]
  }

  /**
   * One import of a batch operator's underwriting credit; its linked key is read at execution time.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param label - The batch operator's durable handle in `ctx.keyStore`.
   * @param keyType - The linked outpost key selecting the shadow credit.
   * @return The Step.
   */
  export function planBatchOperatorSyndicationCredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    keyType: MockSyndicationImportInput["keyType"] = KeyType.ED
  ): ClusterBuildStep<C, BatchOperatorCreditInput> {
    return ClusterBuildStep.create<C, BatchOperatorCreditInput>(
      actor,
      name,
      description,
      options,
      { kind: "RegistrySteps.BatchOperatorCreditInput", label, keyType },
      runBatchOperatorSyndicationCredit
    )
  }

  /**
   * Named runner — ONE `importsynd` credit to the operator's own ED or EM key.
   * The key is the one its matching `createlink` linked, so the credit
   * lands liquid in the operator's account (or parks for that link to sweep).
   */
  export async function runBatchOperatorSyndicationCredit<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: BatchOperatorCreditInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label),
      credit = assertImportCredit(input.keyType),
      key = input.keyType === KeyType.ED ? operator.solana : operator.ethereum
    Assert.ok(
      key != null,
      `mock syndication import: batch operator ${input.label} has no ${KeyType[input.keyType]} key`
    )
    await SyndContractSteps.runImportsynd(
      ctx,
      {
        kind: "SyndContractSteps.ImportsyndInput",
        data: {
          chain_code: credit.chain_code,
          token_code: credit.token_code,
          credits: [
            {
              pubkey: PublicKey.from(key.publicKey).data.hexString,
              amount: credit.amount
            }
          ]
        }
      },
      signal
    )
  }

  /**
   * RAM weight an underwriting batch operator receives, from the bootstrap node owner, for its
   * `sysio.bond` rows: its sponsored account's RAM is spent on registration, and a bond row
   * (~1.3 KB) does not fit in what is left. Lowering it lets `sysio.bond::accept` fail with
   * insufficient RAM.
   */
  export const BatchOperatorUnderwritingRamWeight = Constants.DEFAULT_RAM_WEIGHT

  /**
   * One Phase granting every underwriting batch operator the RAM its bond rows need: one
   * `sysio.roa::addpolicy` Step per operator, issued by the bootstrap node owner.
   *
   * @param batchOperatorLabels - The underwriting operators, already provisioned.
   */
  export function planBatchOperatorUnderwritingResources<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperatorLabels: readonly string[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      batchOperatorLabels.map(label =>
        planBatchOperatorUnderwritingResource<C>(
          Report.Actor.Sysio,
          `underwriting-ram-${label}`,
          `grant ${label} RAM for its sysio.bond rows`,
          options,
          label
        )
      )
    )
  }

  /**
   * One `sysio.roa::addpolicy` granting a batch operator its underwriting RAM.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param label - The batch operator's durable handle in `ctx.keyStore`.
   * @return The Step.
   */
  export function planBatchOperatorUnderwritingResource<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, BatchOperatorResourcesInput> {
    return ClusterBuildStep.create<C, BatchOperatorResourcesInput>(
      actor,
      name,
      description,
      options,
      { kind: "RegistrySteps.BatchOperatorResourcesInput", label },
      runBatchOperatorUnderwritingResources
    )
  }

  /** Input of one {@link planBatchOperatorUnderwritingResources} Step. */
  export interface BatchOperatorResourcesInput extends StepInput {
    readonly kind: "RegistrySteps.BatchOperatorResourcesInput"
    /** The batch operator's durable handle in `ctx.keyStore`. */
    readonly label: string
  }

  /** The `addpolicy` that grants a batch operator account its underwriting RAM. */
  export function batchOperatorUnderwritingPolicy(
    owner: string
  ): SysioContracts.SysioRoaAddpolicyAction {
    return SyndicationUserSteps.nodeOwnerPolicy(owner, {
      // No NET / CPU beyond what the operator already relays with.
      net: Constants.NO_RESOURCE_WEIGHT,
      cpu: Constants.NO_RESOURCE_WEIGHT,
      ram: BatchOperatorUnderwritingRamWeight
    })
  }

  /** Named runner — resolve the operator's generated account, then ONE `addpolicy`. */
  export async function runBatchOperatorUnderwritingResources<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: BatchOperatorResourcesInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await SyndicationUserSteps.runResourcePolicy(
      ctx,
      {
        kind: "SyndicationUserSteps.ResourcePolicyInput",
        data: batchOperatorUnderwritingPolicy(
          ctx.keyStore.assertOperator(input.label).account
        )
      },
      signal
    )
  }

  /** Input for {@link planVerifyMockSyndicationImport}. */
  export interface VerifyMockSyndicationImportInput extends StepInput {
    readonly kind: "RegistrySteps.VerifyMockSyndicationImportInput"
    /** Batch operators whose underwriting credit is verified too. */
    readonly batchOperatorLabels: readonly string[]
  }

  /**
   * Report checkpoint for imported positions, each underwriting operator's credit and an
   * empty mismatch table.
   *
   * @param batchOperatorLabels - The underwriting operators whose credit is checked; empty
   *   when none underwrites.
   */
  export function planVerifyMockSyndicationImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperatorLabels: readonly string[] = []
  ): ClusterBuildStep<C, VerifyMockSyndicationImportInput> {
    return ClusterBuildStep.create<C, VerifyMockSyndicationImportInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "RegistrySteps.VerifyMockSyndicationImportInput",
        batchOperatorLabels
      },
      runVerifyMockSyndicationImport
    )
  }

  /** Read each exact bonder position after import finality; fail on missing or wrong credit. */
  export async function runVerifyMockSyndicationImport<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: VerifyMockSyndicationImportInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const bonder = readMockSyndicationBonder(ctx)
    await eachSeries(MockSyndicationImportCredits, async input => {
      const solana = input.keyType === KeyType.ED,
        pubkey = PublicKey.from(
          (solana ? bonder.solana : bonder.ethereum).publicKey
        ).data.hexString,
        row = await WireSyndicationTool.readParked(
          ctx,
          input.token_code,
          solana
            ? SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM
            : SysioContracts.SysioSyndChainkind.CHAIN_KIND_EVM,
          pubkey
        )
      Assert.ok(
        row,
        `mock syndication import missing parked ${input.token_code}`
      )
      Assert.strictEqual(
        BigInt(row.balance),
        BigInt(input.amount),
        `mock syndication import wrong ${input.token_code} balance`
      )
    })
    await eachSeries(input.batchOperatorLabels, label =>
      eachSeries(MockSyndicationImportCredits, credit =>
        assertBatchOperatorCredit(ctx, label, credit)
      )
    )
    Assert.deepStrictEqual(
      await WireSyndicationTool.readMismatches(ctx),
      [],
      "mock syndication import has custody mismatches"
    )
  }

  /**
   * Assert a batch operator holds exactly its underwriting credit: liquid in its account
   * when its link existed at import, else parked against its ED or EM key for that link.
   */
  async function assertBatchOperatorCredit<C extends ClusterBuildContext>(
    ctx: C,
    label: string,
    credit: MockSyndicationImportInput
  ): Promise<void> {
    const operator = ctx.keyStore.assertOperator(label),
      { token_code } = credit,
      solana = credit.keyType === KeyType.ED,
      key = solana ? operator.solana : operator.ethereum,
      parked = await WireSyndicationTool.readParked(
        ctx,
        token_code,
        solana
          ? SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM
          : SysioContracts.SysioSyndChainkind.CHAIN_KIND_EVM,
        PublicKey.from(key.publicKey).data.hexString
      ),
      parkedBalance = parked ? BigInt(parked.balance) : 0n,
      liquid = await WireSyndicationTool.readLiqBalance(
        ctx,
        operator.account,
        token_code
      )
    Assert.strictEqual(
      parkedBalance + liquid,
      BigInt(credit.amount),
      `mock syndication import: ${label} holds ${liquid} liquid + ${parkedBalance} parked ${token_code}, expected ${credit.amount}`
    )
    Assert.ok(
      parkedBalance === 0n || liquid === 0n,
      `mock syndication import: ${label}'s credit is split between liquid and parked`
    )
  }

  /** Durable identity named explicitly in the bonder's materialization Report row. */
  export interface MockSyndicationBonderInput extends StepInput {
    readonly kind: "RegistrySteps.MockSyndicationBonderInput"
    readonly label: string
    readonly ethereumHdIndex: number
  }

  /** Create the local key material as a Report-visible Step. */
  export function planMockSyndicationBonder<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, MockSyndicationBonderInput> {
    return ClusterBuildStep.create<C, MockSyndicationBonderInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "RegistrySteps.MockSyndicationBonderInput",
        label: MockSyndicationBonderLabel,
        ethereumHdIndex: MockSyndicationBonderEthereumHdIndex
      },
      runMockSyndicationBonder
    )
  }

  /** Generate ED and EM keys once, keeping the bonder unlinked so imports park. */
  export async function runMockSyndicationBonder<C extends ClusterBuildContext>(
    ctx: C,
    input: MockSyndicationBonderInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.strictEqual(
      input.label,
      MockSyndicationBonderLabel,
      "unexpected mock bonder label"
    )
    Assert.strictEqual(
      input.ethereumHdIndex,
      MockSyndicationBonderEthereumHdIndex,
      "unexpected mock bonder HD index"
    )
    Assert.ok(
      !ctx.outputs.get(MockSyndicationBonderKey),
      "mock syndication bonder already exists"
    )
    const keyContext = KeySteps.keyGeneratorContext(ctx),
      solana = await KeyGenerator.create(KeyType.ED, keyContext, {
        purpose: input.label
      }),
      ethereum = await KeyGenerator.create(KeyType.EM, keyContext, {
        purpose: input.label,
        ethereumHdIndex: input.ethereumHdIndex
      })
    Fs.mkdirSync(ctx.config.dataPath, { recursive: true })
    Fs.writeFileSync(
      SolanaFundingTool.keypairFile(
        ctx.config.dataPath,
        MockSyndicationBonderLabel
      ),
      JSON.stringify(Array.from(solanaKeypair(solana).secretKey)),
      { mode: 0o600, flag: "wx" }
    )
    const bonder: MockSyndicationBonderOutput = { solana, ethereum }
    Fs.writeFileSync(
      Path.join(ctx.config.dataPath, `${MockSyndicationBonderLabel}.json`),
      JSON.stringify(bonder),
      { mode: 0o600, flag: "wx" }
    )
    ctx.outputs.set(MockSyndicationBonderKey, bonder)
  }

  /** Reload the unlinked bonder from its durable label after bootstrap or a context restart. */
  export function readMockSyndicationBonder<C extends ClusterBuildContext>(
    ctx: C
  ): MockSyndicationBonderOutput {
    const cached = ctx.outputs.get(MockSyndicationBonderKey)
    if (cached) return cached
    const file = Path.join(
      ctx.config.dataPath,
      `${MockSyndicationBonderLabel}.json`
    )
    Assert.ok(
      Fs.existsSync(file),
      "mock syndication bonder has not been provisioned"
    )
    const saved = JSON.parse(
        Fs.readFileSync(file, "utf8")
      ) as MockSyndicationBonderOutput,
      bonder: MockSyndicationBonderOutput = {
        solana: keyPairFromPrivate(
          KeyType.ED,
          PrivateKey.from(saved.solana.privateKey).toNativeString()
        ),
        ethereum: keyPairFromPrivate(
          KeyType.EM,
          PrivateKey.from(saved.ethereum.privateKey).toNativeString()
        )
      }
    Assert.strictEqual(
      bonder.solana.publicKey,
      saved.solana.publicKey,
      "bonder ED key mismatch"
    )
    Assert.strictEqual(
      bonder.ethereum.publicKey,
      saved.ethereum.publicKey,
      "bonder EM key mismatch"
    )
    ctx.outputs.set(MockSyndicationBonderKey, bonder)
    return bonder
  }

  /** One import action; the bonder public key is loaded at execution time. */
  export function planMockSyndicationCredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    input: MockSyndicationImportInput
  ): ClusterBuildStep<C, MockSyndicationImportInput> {
    return ClusterBuildStep.create<C, MockSyndicationImportInput>(
      actor,
      name,
      description,
      options,
      input,
      runMockSyndicationCredit
    )
  }

  /** Resolve the canonical ED/EM key to its native bytes and perform one importsynd. */
  export async function runMockSyndicationCredit<C extends ClusterBuildContext>(
    ctx: C,
    input: MockSyndicationImportInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const bonder = readMockSyndicationBonder(ctx),
      key = input.keyType === KeyType.ED ? bonder.solana : bonder.ethereum
    Assert.ok(key, "mock syndication bonder is missing its import key")
    await SyndContractSteps.runImportsynd(
      ctx,
      {
        kind: "SyndContractSteps.ImportsyndInput",
        data: {
          chain_code: input.chain_code,
          token_code: input.token_code,
          credits: [
            {
              pubkey: PublicKey.from(key.publicKey).data.hexString,
              amount: input.amount
            }
          ]
        }
      },
      signal
    )
  }

  /**
   * The 2 `sysio.liq::create` rows — one shadow symbol per registered liq
   * token, bound to that token's chain. Shared by {@link planShadowLiqTokens}
   * (one Report step per row) and its unit test.
   */
  export const ShadowLiqTokenRegistrations: SysioContracts.SysioLiqCreateAction[] =
    Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chainCodename, tokenCodename]) => ({
      sym: Constants.liqSymbol(tokenCodename),
      chain_code: chainCodename,
      token_code: tokenCodename
    }))

  /**
   * The 2 mock `sysio.liq::regliqpool` rows — one yield pool per shadow, seeded
   * from the system account. Shared by {@link planMockLiqPools} (one Report step
   * per row) and its unit test. The contract gates `regliqpool` to the bootstrap
   * window (epoch 0), so these seed ONLY during bootstrap — never from a flow phase.
   */
  export const MockLiqPoolRegistrations: SysioContracts.SysioLiqRegliqpoolAction[] =
    Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chainCodename, tokenCodename]) => ({
      chain_code: chainCodename,
      token_code: tokenCodename,
      pair_symbol: Constants.liqSymbol(Constants.liqPoolPairCode(tokenCodename)),
      initial_chain_amount: MockLiqPoolShadowSeed,
      initial_wire_amount: MockLiqPoolWireSeed,
      fee: MockLiqPoolFee,
      locked_shares: MockLiqPoolLockedShares,
      conversion_horizon_sec: MockLiqPoolConversionHorizonSec,
      depth_cap_bps: MockLiqPoolDepthCapBps,
      clip_floor: MockLiqPoolClipFloor
    }))

  /**
   * The bootstrap's `sysio.kicker::setconfig` — {@link KickerBudget} and
   * {@link KickerMinIntervalSec}. Shared by {@link planKicker} and its unit test.
   */
  export const KickerConfiguration: SysioContracts.SysioKickerSetconfigAction = {
    cfg: {
      budget_remaining: KickerBudget,
      min_interval_sec: KickerMinIntervalSec,
      twap_window_sec: KickerTwapWindowSec,
      max_spot_deviation_bps: KickerMaxSpotDeviationBps
    }
  }

  /**
   * The `sysio.kicker::addpool` rows — one per shadow, in
   * {@link Constants.SHADOW_LIQ_TOKEN_PAIRS} order, at the contract's default rate, minimum gift
   * and mandatory daily ceiling. `addpool` refuses a token without its LIQ/WIRE
   * yield pool, so these follow {@link MockLiqPoolRegistrations}. Shared by
   * {@link planKickerPools} (one Report step per row) and its unit test.
   */
  export const KickerPoolRegistrations: SysioContracts.SysioKickerAddpoolAction[] =
    Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([, tokenCodename]) => ({
      sym: tokenCodename,
      rate_bps: KickerRateBps,
      min_gift: KickerMinGift,
      max_gift_per_day: KickerMaxGiftPerDay
    }))

  /**
   * The `sysio.synd::setconfig` row of each shadow pair — one per liq token
   * {@link runSeedRegistry} registers, in {@link Constants.SHADOW_LIQ_TOKEN_PAIRS} order. A pair with no
   * row releases no syndication and accepts no desyndication, so a real depot configures
   * every pair too: {@link planSyndicationConfig} writes these unconditionally. Shared by
   * that phase (one Report step per row) and its unit test.
   */
  export const SyndicationConfigRegistrations: SysioContracts.SysioSyndSetconfigAction[] =
    Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chainCodename, tokenCodename]) => ({
      chain_code: chainCodename,
      token_code: tokenCodename,
      synd_fee_bps: SyndicationFeeBps,
      desynd_fee_bps: DesyndicationFeeBps,
      synd_burst: SyndicationBucketSize,
      synd_refill: SyndicationBucketSize,
      desynd_burst: SyndicationBucketSize,
      desynd_refill: SyndicationBucketSize,
      window_sec: ProtocolTiming.SyndicationChallengeWindowSec,
      bounty: SyndicationBounty,
      challenge_extra: SyndicationChallengeExtra,
      min_desyndicate: MinimumDesyndications[tokenCodename],
      desynd_fee_flat: DesyndicationFlatFees[tokenCodename],
      custody_shortfall_bps: tokenCodename === LiqEthCodename ? LiqEthCustodyShortfallBps : 0
    }))

  /** Seed chains + tokens + chain-token bindings. */
  export function planSeedRegistry<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runSeedRegistry
    )
  }

  /**
   * Write each outpost chain's remote contract addresses onto its
   * `sysio.chains` row.
   *
   * Split out from {@link planSeedRegistry} because it needs the daemon
   * artifacts, which are published in a LATER phase: the SOL program id
   * resolves from the deployed program (or, in external-outpost mode, from the
   * external config), not from anything the registry phase can see. Must run
   * before the operator daemons start — a batch operator skips a chain whose
   * addresses are unset, and an underwriter's preflight fails closed on one.
   */
  export function planSeedOutpostAddresses<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runSeedOutpostAddresses
    )
  }

  /** Named runner — `sysio.chains::setoutpost` for every outpost chain. */
  export async function runSeedOutpostAddresses<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const artifacts = ctx.outputs.assert(OperatorDaemonArtifactsKey),
      chains = ctx.wire.getSysioContract(SysioContractName.chains),
      ethAddress = (contractName: string): string => {
        const address = artifacts.ethereumAddresses[contractName]
        if (address == null || address.length === 0) {
          throw new Error(
            `RegistrySteps: ${contractName} address missing from outpost-addrs.json`
          )
        }
        return address
      }

    await chains.actions.setoutpost.invoke({
      code: Constants.ETHEREUM_CHAIN_CODENAME,
      outpost: {
        opp_addr: ethAddress("OPP"),
        opp_inbound_addr: ethAddress("OPPInbound")
      }
    })
    // One Solana program receives inbound and emits outbound envelopes, so it
    // goes in `opp_addr` alone — `sysio.chains` rejects an SVM row that sets
    // `opp_inbound_addr`.
    await chains.actions.setoutpost.invoke({
      code: Constants.SOLANA_CHAIN_CODENAME,
      outpost: {
        opp_addr: artifacts.solanaProgramId,
        opp_inbound_addr: ""
      }
    })
  }

  /**
   * ONE phase of per-shadow `sysio.liq::create` steps — the shadow symbols the
   * depot mints syndicated liq into, one per registered liq token. Registry
   * setup, not mock data: a real depot opens the same symbols, so this phase is
   * unconditional. It runs after {@link planSeedRegistry} (each shadow binds to
   * a registered, active liq token) and after `sysio.swap` is configured (the
   * pools below trade the shadows against its system token). Self-registers
   * on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every create step.
   * @returns The self-registered shadow-token phase.
   */
  export function planShadowLiqTokens<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = Constants.SHADOW_LIQ_TOKEN_PAIRS.map(
      ([, tokenCodename], index) =>
        LiqContractSteps.planCreate<C>(
          Report.Actor.Sysio,
          `create-shadow-${tokenCodename.toLowerCase()}`,
          `open the ${tokenCodename} shadow symbol on sysio.liq`,
          options,
          ShadowLiqTokenRegistrations[index]
        )
    )
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /**
   * ONE phase configuring underwriting and syndication, after the shadow symbols exist:
   * `sysio.bond::setconfig` ({@link BondHoldBps}), one `sysio.synd::setconfig` per shadow
   * pair ({@link SyndicationConfigRegistrations}), then the verify Steps of the
   * syndication preconditions: one that every shadow is at the depot frame's precision,
   * and one per shadow that its `(chain, token)` is an active TOKEN_KIND_LIQ token with an
   * active binding (without it `sysio.msgch` drops every `SYNDICATE_LIQ` of the pair). Registry setup a
   * real depot performs too, so the bootstrap composes it unconditionally. Self-registers
   * on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every step.
   * @returns The self-registered configuration phase.
   */
  export function planSyndicationConfig<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = [
      BondContractSteps.planSetconfig<C>(
        Report.Actor.Sysio,
        "configure-bond",
        "set sysio.bond's hold bond",
        options,
        { hold_bps: BondHoldBps }
      ),
      ...Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chainCodename, tokenCodename], index) =>
        SyndContractSteps.planSetconfig<C>(
          Report.Actor.Sysio,
          `configure-syndication-${chainCodename.toLowerCase()}-${tokenCodename.toLowerCase()}`,
          `set the ${chainCodename}/${tokenCodename} syndication rules on sysio.synd`,
          options,
          SyndicationConfigRegistrations[index]
        )
      ),
      WireSyndicationTool.planVerifyShadowPrecision<C>(
        Report.Actor.Sysio,
        "verify-shadow-precision",
        "every shadow symbol is at the depot frame's precision, which sysio.bond can bond",
        options,
        Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([, tokenCodename]) => tokenCodename)
      ),
      ...Constants.SHADOW_LIQ_TOKEN_PAIRS.map(([chainCodename, tokenCodename]) =>
        WireSyndicationTool.planVerifyLiqTokenActive<C>(
          Report.Actor.Sysio,
          `verify-liq-token-${chainCodename.toLowerCase()}-${tokenCodename.toLowerCase()}`,
          `${chainCodename}/${tokenCodename} is an active liq token with an active binding`,
          options,
          chainCodename,
          tokenCodename
        )
      )
    ]
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /**
   * ONE phase of per-pool `sysio.liq::regliqpool` steps — the mock shadow-liq
   * yield pools on `sysio.swap`, gated behind `--enable-mock-liq-pools` (default
   * off, so a real / external depot never mints unbacked shadow). The contract
   * gates `regliqpool` to the bootstrap window (epoch 0), so this phase only
   * ever runs pre-EpochBootstrap and can never be reached from a flow phase.
   * Runs after {@link planShadowLiqTokens}. Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every pool step.
   * @param registrations - The pools to seed: {@link MockLiqPoolRegistrations} less any shadow
   *   whose one pool the launch-data import seeds instead.
   * @returns The self-registered pool-seeding phase.
   */
  export function planMockLiqPools<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    registrations: readonly SysioContracts.SysioLiqRegliqpoolAction[] = MockLiqPoolRegistrations
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = registrations.map(registration =>
      LiqContractSteps.planRegliqpool<C>(
        Report.Actor.Sysio,
        `seed-liq-pool-${registration.chain_code.toLowerCase()}-${registration.token_code.toLowerCase()}`,
        `seed the ${registration.token_code}/WIRE yield pool on sysio.swap`,
        options,
        registration
      )
    )
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /**
   * ONE phase standing up `sysio.kicker`: deploy it privileged through
   * `setsyscode`, read the privilege back (its `kick` draws from `sysio` with an
   * inline transfer under `sysio@active`, which only a privileged contract may
   * send), then `setconfig` with {@link KickerConfiguration}. Registry setup a
   * real depot performs too (`docs/platform-bootstrap-config.md`, "Kicker
   * deployment and earmark"), so the bootstrap composes it unconditionally, after
   * the emission config and any yield pool exist. Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every step.
   * @returns The self-registered kicker phase.
   */
  export function planKicker<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const account = SysioContractAccount[SysioContractName.kicker],
      steps: ClusterBuildStep.Any<C>[] = [
        ContractSteps.planDeploy<C>(
          Report.Actor.Sysio,
          "deploy-kicker",
          "setsyscode sysio.kicker (privileged)",
          options,
          SysioContractName.kicker,
          ContractSteps.DeployMode.system
        ),
        ContractSteps.planVerifyPrivileged<C>(
          Report.Actor.Sysio,
          "verify-kicker-privileged",
          `${account} is privileged, so kick may draw from sysio under sysio@active`,
          options,
          account
        ),
        KickerContractSteps.planSetconfig<C>(
          Report.Actor.Sysio,
          "configure-kicker",
          `set the kicker's ${KickerBudget}-unit WIRE budget and ${KickerMinIntervalSec} s minimum interval`,
          options,
          KickerConfiguration
        )
      ]
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /**
   * ONE phase of per-token `sysio.kicker::addpool` steps
   * ({@link KickerPoolRegistrations}), which start each LIQ token's accrual clock.
   * `addpool` requires the token's LIQ/WIRE yield pool, which only
   * {@link planMockLiqPools} registers on a cluster, so the bootstrap composes
   * this phase exactly when it composes that one, after it and after
   * {@link planKicker}. Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every addpool step.
   * @returns The self-registered pool phase.
   */
  export function planKickerPools<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = KickerPoolRegistrations.map(
      registration =>
        KickerContractSteps.planAddpool<C>(
          Report.Actor.Sysio,
          `add-kicker-pool-${registration.sym.toLowerCase()}`,
          `start ${registration.sym}'s kicker accrual at ${registration.rate_bps} bps`,
          options,
          registration
        )
    )
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  /** Named runner — port of the old `ClusterManager` Phase 16 / 16a / 16b (chains, tokens, chain-token bindings). */
  export async function runSeedRegistry<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chains = ctx.wire.getSysioContract(SysioContractName.chains),
      tokens = ctx.wire.getSysioContract(SysioContractName.tokens),
      ethereumAddresses = readJson(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          "outpost-addrs.json"
        )
      ),
      liqEthAddresses = readJson(
        Path.join(
          ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
          "liqeth-addrs.json"
        )
      ),
      solanaMints = readSolanaMints(
        Path.join(ctx.config.dataPath, "sol-mock-mints.json")
      ),
      strip0x = (hex: string): string => hex.replace(/^0x/i, ""),
      emptyAddress = {
        kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      },
      evmAddress = (hex: string | null) =>
        hex != null
          ? { kind: SysioTokensChainkind.CHAIN_KIND_EVM, address: strip0x(hex) }
          : emptyAddress,
      svmAddress = (mintBase58: string | null) =>
        mintBase58 != null
          ? {
              kind: SysioTokensChainkind.CHAIN_KIND_SVM,
              address: Buffer.from(
                new SolanaPublicKey(mintBase58).toBytes()
              ).toString("hex")
            }
          : emptyAddress

    // ── chains ──
    // Remote outpost contract addresses are seeded LATER, by
    // `runSeedOutpostAddresses`: the SOL program id only resolves once the
    // daemon artifacts are published, and in external-outpost mode it comes
    // from the external config rather than the local keypair. `sysio.chains`
    // supports register-then-configure precisely for this, and both operator
    // daemons skip a chain whose addresses are not set yet.
    const emptyOutpost: SysioContracts.SysioChainsOutpostAddrsType = {
      opp_addr: "",
      opp_inbound_addr: ""
    }
    const chainRegistrations: SysioContracts.SysioChainsRegchainAction[] = [
      {
        kind: SysioChainsChainkind.CHAIN_KIND_WIRE,
        code: "WIRE",
        external_chain_id: 0,
        name: "Wire (depot)",
        description: "The WIRE depot chain itself",
        outpost: emptyOutpost
      },
      {
        kind: SysioChainsChainkind.CHAIN_KIND_EVM,
        code: Constants.ETHEREUM_CHAIN_CODENAME,
        // External-outpost mode registers the REAL remote chain id so the
        // depot's chains row matches what the daemons dial (networkFromConfig).
        external_chain_id:
          ctx.config.externalOutposts?.ethereum.chainId ??
          AnvilProcess.DefaultChainId,
        name: "Ethereum (anvil)",
        description: "Local anvil EVM chain (test cluster)",
        outpost: emptyOutpost
      },
      {
        kind: SysioChainsChainkind.CHAIN_KIND_SVM,
        code: Constants.SOLANA_CHAIN_CODENAME,
        external_chain_id: 0,
        name: "Solana (test-validator)",
        description: "Local solana-test-validator (test cluster)",
        outpost: emptyOutpost
      }
    ]
    await eachSeries(chainRegistrations, data =>
      chains.actions.regchain.invoke(data)
    )

    // ── tokens ──
    const tokenRegistrations: SysioContracts.SysioTokensRegtokenAction[] = [
      nativeToken("WIRE", "Wire", "WIRE chain native asset"),
      nativeToken("ETH", "Ether", "Ethereum native asset"),
      liqToken(
        "LIQETH",
        "Liquid ETH",
        "Liquid-staking receipt for ETH",
        evmAddress(liqEthAddresses.LiqEthToken)
      ),
      erc20Token(
        "USDC",
        "USD Coin",
        "USDC stablecoin on Ethereum",
        evmAddress(ethereumAddresses.MockUsdc)
      ),
      erc20Token(
        "USDT",
        "Tether USD",
        "USDT stablecoin on Ethereum",
        evmAddress(ethereumAddresses.MockUsdt)
      ),
      nativeToken("SOL", "Sol", "Solana native asset"),
      liqToken(
        Constants.LIQSOL_CODENAME,
        "Liquid SOL",
        "Liquid-staking receipt for SOL",
        svmAddress(solanaMints.LIQSOL)
      ),
      splToken(
        "USDCSOL",
        "USDC (Solana)",
        "USDC stablecoin on Solana",
        svmAddress(solanaMints.USDC)
      ),
      splToken(
        "USDTSOL",
        "USDT (Solana)",
        "USDT stablecoin on Solana",
        svmAddress(solanaMints.USDT)
      )
    ]
    await eachSeries(tokenRegistrations, data =>
      tokens.actions.regtoken.invoke(data)
    )

    // ── chain-token bindings ──
    const chainTokenBindings: SysioContracts.SysioTokensRegctokAction[] = [
      chainToken("WIRE", "WIRE", "", true),
      chainToken(Constants.ETHEREUM_CHAIN_CODENAME, "ETH", "", true),
      chainToken(
        Constants.ETHEREUM_CHAIN_CODENAME,
        "LIQETH",
        nullableStrip(liqEthAddresses.LiqEthToken, strip0x),
        false
      ),
      chainToken(
        Constants.ETHEREUM_CHAIN_CODENAME,
        "USDC",
        nullableStrip(ethereumAddresses.MockUsdc, strip0x),
        false
      ),
      chainToken(
        Constants.ETHEREUM_CHAIN_CODENAME,
        "USDT",
        nullableStrip(ethereumAddresses.MockUsdt, strip0x),
        false
      ),
      chainToken(Constants.SOLANA_CHAIN_CODENAME, "SOL", "", true),
      chainToken(
        Constants.SOLANA_CHAIN_CODENAME,
        Constants.LIQSOL_CODENAME,
        nullableMintHex(solanaMints.LIQSOL),
        false
      ),
      chainToken(
        Constants.SOLANA_CHAIN_CODENAME,
        "USDCSOL",
        nullableMintHex(solanaMints.USDC),
        false
      ),
      chainToken(
        Constants.SOLANA_CHAIN_CODENAME,
        "USDTSOL",
        nullableMintHex(solanaMints.USDT),
        false
      )
    ]
    await eachSeries(chainTokenBindings, data =>
      tokens.actions.regctok.invoke(data)
    )
  }

  // ── token-row builders (native = empty addr; the rest carry a ChainAddress) ──

  function nativeToken(
    codename: string,
    symbolName: string,
    description: string
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: codename,
      symbol_name: symbolName,
      description,
      precision: 9,
      address: { kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN, address: "" }
    }
  }

  function liqToken(
    codename: string,
    symbolName: string,
    description: string,
    address: SysioContracts.SysioTokensChainaddressType
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_LIQ,
      code: codename,
      symbol_name: symbolName,
      description,
      precision: Constants.LIQ_TOKEN_PRECISION,
      address
    }
  }

  function erc20Token(
    codename: string,
    symbolName: string,
    description: string,
    address: SysioContracts.SysioTokensChainaddressType
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_ERC20,
      code: codename,
      symbol_name: symbolName,
      description,
      precision: 6,
      address
    }
  }

  function splToken(
    codename: string,
    symbolName: string,
    description: string,
    address: SysioContracts.SysioTokensChainaddressType
  ): SysioContracts.SysioTokensRegtokenAction {
    return {
      kind: SysioTokensTokenkind.TOKEN_KIND_SPL,
      code: codename,
      symbol_name: symbolName,
      description,
      precision: 6,
      address
    }
  }

  function chainToken(
    chainCodename: string,
    tokenCodename: string,
    contractAddress: string,
    isNative: boolean
  ): SysioContracts.SysioTokensRegctokAction {
    return {
      chain_code: chainCodename,
      token_code: tokenCodename,
      contract_addr: contractAddress,
      is_native: isNative
    }
  }

  /** Read a deploy-artifact JSON, or `{}` when the file is absent. */
  function readJson(file: string): Record<string, string> {
    return Fs.existsSync(file) ? JSON.parse(Fs.readFileSync(file, "utf-8")) : {}
  }

  /**
   * Read `sol-mock-mints.json` (array of `{code, mint, decimals}`) into a
   * codename → base58-mint map, reverse-mapping the persisted numeric slug code.
   */
  export function readSolanaMints(file: string): Record<string, string> {
    if (!Fs.existsSync(file)) return {}
    const rows = JSON.parse(
      Fs.readFileSync(file, "utf-8")
    ) as SolanaFundingTool.SolMockMint[]
    const out: Record<string, string> = {}
    rows.forEach(row => {
      ;["USDC", "USDT", Constants.LIQSOL_CODENAME].forEach(codename => {
        if (SlugName.from(codename) === row.code) out[codename] = row.mint
      })
    })
    return out
  }

  /** `strip0x(hex)` when present, else `""`. */
  function nullableStrip(
    hex: string | null,
    strip: (h: string) => string
  ): string {
    return hex != null ? strip(hex) : ""
  }

  /** Base58 mint → chain-native hex, else `""`. */
  function nullableMintHex(mintBase58: string | null): string {
    return mintBase58 != null
      ? Buffer.from(new SolanaPublicKey(mintBase58).toBytes()).toString("hex")
      : ""
  }
}
