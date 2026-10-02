import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import { KeyType, PrivateKey, PublicKey, SlugName, SysioContracts } from "@wireio/sdk-core"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { keyPairFromPrivate, solanaKeypair } from "../../utils/keyPairUtils.js"
import type { StepInput } from "../StepRunner.js"
import { MockSyndicationBonderKey, type MockSyndicationBonderOutput } from "../outputs/MockSyndicationBonderOutput.js"
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
import { ProtocolTiming } from "../../Constants.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { BondContractSteps } from "./contracts/sysio/BondContractSteps.js"
import { LiqContractSteps } from "./contracts/sysio/LiqContractSteps.js"
import { ReservContractSteps } from "./contracts/sysio/ReservContractSteps.js"
import { SyndContractSteps } from "./contracts/sysio/SyndContractSteps.js"
import { OperatorDaemonArtifactsKey } from "../outputs/OperatorDaemonArtifacts.js"

const {
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
  /** Bootstrap reserve chain/wire seed amount (each token's depot frame = `min(native, 9)` decimals). */
  const ReserveSeedAmount = 10_000_000_000
  /** Bancor connector weight (bps) for every bootstrap reserve. */
  const ConnectorWeightBps = 5000
  /** Codenames whose reserves carry native 6-dec precision (stablecoins). */
  const StableCodenames = ["USDC", "USDT", "USDCSOL", "USDTSOL"]
  /** Reserve code every mock reserve registers under. */
  const PrimaryReserveCodename = "PRIMARY"
  /** Divisor on a stablecoin reserve's chain seed (its 6-dec frame vs the 9-dec default). */
  const StableChainSeedDivisor = 1000
  /** `source_token_precision` for a stablecoin reserve (native 6-dec). */
  const StableTokenPrecision = 6
  /** `source_token_precision` for every non-stablecoin reserve (depot 9-dec frame). */
  const DefaultTokenPrecision = 9
  /**
   * The 8 mock (chain, token) reserve pairs — `[chainCodename, tokenCodename,
   * label]`. Private source both {@link MockReserveRegistrations} (the rows) and
   * {@link planMockReserves} (the per-step names) derive from, in this order.
   */
  const MockReservePairs = [
    ["ETHEREUM", "ETH", "native ETH"],
    ["ETHEREUM", "LIQETH", "liqETH"],
    ["ETHEREUM", "USDC", "USDC (mock ERC-20)"],
    ["ETHEREUM", "USDT", "USDT (mock ERC-20)"],
    ["SOLANA", "SOL", "native SOL"],
    ["SOLANA", "LIQSOL", "liqSOL"],
    ["SOLANA", "USDCSOL", "USDC (mock SPL)"],
    ["SOLANA", "USDTSOL", "USDT (mock SPL)"]
  ] as const

  /**
   * The 8 mock (chain, token) PRIMARY `sysio.reserv::regreserve` rows — fully
   * static (string codenames + numeric constants, no deploy-artifact reads),
   * byte-identical to the pre-split unconditional seeding. Shared by
   * {@link planMockReserves} (one Report step per row) and its unit test. The
   * contract gates `regreserve` to the bootstrap window (epoch 0), so these seed
   * ONLY during bootstrap — never from a flow phase.
   */
  export const MockReserveRegistrations: SysioContracts.SysioReservRegreserveAction[] =
    MockReservePairs.map(([chainCodename, tokenCodename, label]) =>
      toReserveRegistration(chainCodename, tokenCodename, label)
    )

  /**
   * The shadow liq symbols the bootstrap opens on `sysio.liq` — `[chainCodename,
   * tokenCodename]`, one per liq token {@link runSeedRegistry} registers. Private
   * source both {@link ShadowLiqTokenRegistrations} and
   * {@link MockLiqPoolRegistrations} derive from, in this order.
   */
  const ShadowLiqTokenPairs = [
    ["ETHEREUM", "LIQETH"],
    ["SOLANA", "LIQSOL"]
  ] as const
  /** Depot-frame precision every liq token is registered at, which its shadow symbol carries. */
  const LiqTokenPrecision = 9
  /** Suffix on a shadow's token codename naming its yield pool's pair token (`LIQSOL` → `LIQSOLP`). */
  const LiqPoolPairSuffix = "P"
  /**
   * Mock yield-pool parameters, per pool. The two seeds and the fee mirror the
   * dev bootstrap config (`etc/config/dex/dex-config.dev.json`); the tick pacing
   * is the dev cluster's own — a 30 s horizon and a 30 % depth cap sell a flow's
   * reported yield in ONE tick, so a scenario observes one index bump and then a
   * stable ledger instead of a day-long drip.
   */
  const MockLiqPoolShadowSeed = 10_000_000_000
  /** WIRE (9-dec base units) the system account seeds each mock pool with. */
  const MockLiqPoolWireSeed = 10_000_000_000
  /** Swap fee of each mock pool, per ten-thousand (0.30 %). */
  const MockLiqPoolFee = 30
  /** Pair-token shares locked at each mock pool's creation. */
  const MockLiqPoolLockedShares = 0
  /** Seconds over which a mock pool's reservoir is time-shared into clips. */
  const MockLiqPoolConversionHorizonSec = 30
  /** Ceiling of one clip as bps of the pool's shadow depth. */
  const MockLiqPoolDepthCapBps = 3000
  /** Smallest clip (shadow base units) a mock pool sells. */
  const MockLiqPoolClipFloor = 1000
  /**
   * `sysio.bond`'s hold bond, in basis points of a request's covered amount — the
   * contract's own default, set explicitly so the bootstrap states it.
   */
  export const BondHoldBps = 1000
  /**
   * Fee on each released syndication tranche and on each desyndication (bps). The
   * bootstrap charges none; a flow that exercises the fee path sets its own through
   * `sysio.synd::setconfig` in its scenario and restores this.
   */
  export const SyndicationFeeBps = 0
  /** Fee on each desyndication (bps); see {@link SyndicationFeeBps}. */
  export const DesyndicationFeeBps = 0
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
      chain_code: "SOLANA",
      token_code: "LIQSOL",
      keyType: KeyType.ED,
      amount: MockSyndicationImportAmount
    },
    {
      kind: "RegistrySteps.MockSyndicationImportInput",
      chain_code: "ETHEREUM",
      token_code: "LIQETH",
      keyType: KeyType.EM,
      amount: MockSyndicationImportAmount
    }
  ]

  /** Provision the import identity, import each position separately, then seal import. */
  export function planMockSyndicationImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
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
        "both credits are parked and no custody mismatch exists",
        options
      )
    ])
  }

  /** Report checkpoint for imported parked positions and an empty mismatch table. */
  export function planVerifyMockSyndicationImport<
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
      runVerifyMockSyndicationImport
    )
  }

  /** Read each exact bonder position after import finality; fail on missing or wrong credit. */
  export async function runVerifyMockSyndicationImport<
    C extends ClusterBuildContext
  >(ctx: C, _input: null, signal: AbortSignal): Promise<void> {
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
    Assert.deepStrictEqual(
      await WireSyndicationTool.readMismatches(ctx),
      [],
      "mock syndication import has custody mismatches"
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

  /** A symbol in ABI form (`9,LIQSOL`) from a codename, at the liq precision. */
  function liqSymbol(codename: string): string {
    return `${LiqTokenPrecision},${codename}`
  }

  /**
   * The 2 `sysio.liq::create` rows — one shadow symbol per registered liq
   * token, bound to that token's chain. Shared by {@link planShadowLiqTokens}
   * (one Report step per row) and its unit test.
   */
  export const ShadowLiqTokenRegistrations: SysioContracts.SysioLiqCreateAction[] =
    ShadowLiqTokenPairs.map(([chainCodename, tokenCodename]) => ({
      sym: liqSymbol(tokenCodename),
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
    ShadowLiqTokenPairs.map(([chainCodename, tokenCodename]) => ({
      chain_code: chainCodename,
      token_code: tokenCodename,
      pair_symbol: liqSymbol(`${tokenCodename}${LiqPoolPairSuffix}`),
      initial_chain_amount: MockLiqPoolShadowSeed,
      initial_wire_amount: MockLiqPoolWireSeed,
      fee: MockLiqPoolFee,
      locked_shares: MockLiqPoolLockedShares,
      conversion_horizon_sec: MockLiqPoolConversionHorizonSec,
      depth_cap_bps: MockLiqPoolDepthCapBps,
      clip_floor: MockLiqPoolClipFloor
    }))

  /**
   * The `sysio.synd::setconfig` row of each shadow pair — one per liq token
   * {@link runSeedRegistry} registers, in {@link ShadowLiqTokenPairs} order. A pair with no
   * row releases no syndication and accepts no desyndication, so a real depot configures
   * every pair too: {@link planSyndicationConfig} writes these unconditionally. Shared by
   * that phase (one Report step per row) and its unit test.
   */
  export const SyndicationConfigRegistrations: SysioContracts.SysioSyndSetconfigAction[] =
    ShadowLiqTokenPairs.map(([chainCodename, tokenCodename]) => ({
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
      challenge_extra: SyndicationChallengeExtra
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
      code: "ETHEREUM",
      outpost: {
        opp_addr: ethAddress("OPP"),
        opp_inbound_addr: ethAddress("OPPInbound"),
        operator_registry_addr: ethAddress("OperatorRegistry"),
        source_deposit_addr: ethAddress("ReserveManager")
      }
    })
    // One Solana program serves every role, so it goes in `opp_addr` alone —
    // `sysio.chains` rejects an SVM row that fills the role-specific fields.
    await chains.actions.setoutpost.invoke({
      code: "SOLANA",
      outpost: {
        opp_addr: artifacts.solanaProgramId,
        opp_inbound_addr: "",
        operator_registry_addr: "",
        source_deposit_addr: ""
      }
    })
  }

  /**
   * Seed the 8 mock (chain, token) PRIMARY reserves as ONE
   * {@link ClusterBuildPhase} of per-reserve `sysio.reserv::regreserve` steps —
   * every reserve write is its own Report-validated step (the rows are fully
   * static, from {@link MockReserveRegistrations}). Composed ONLY when
   * `--enable-mock-reserves` is set; the depot contract gates `regreserve` to
   * the bootstrap window (epoch 0), so this phase only ever runs
   * pre-EpochBootstrap and can never be reached from a flow phase.
   * Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every reserve step.
   * @returns The self-registered reserve-seeding phase.
   */
  export function planMockReserves<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = MockReservePairs.map(
      ([chainCodename, tokenCodename], index) =>
        ReservContractSteps.planRegreserve<C>(
          Report.Actor.Sysio,
          `seed-reserve-${chainCodename.toLowerCase()}-${tokenCodename.toLowerCase()}`,
          `seed the ${chainCodename}/${tokenCodename} PRIMARY reserve`,
          options,
          MockReserveRegistrations[index]
        )
    )
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
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
    const steps: ClusterBuildStep.Any<C>[] = ShadowLiqTokenPairs.map(
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
      ...ShadowLiqTokenPairs.map(([chainCodename, tokenCodename], index) =>
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
        ShadowLiqTokenPairs.map(([, tokenCodename]) => tokenCodename)
      ),
      ...ShadowLiqTokenPairs.map(([chainCodename, tokenCodename]) =>
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
   * @returns The self-registered pool-seeding phase.
   */
  export function planMockLiqPools<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = ShadowLiqTokenPairs.map(
      ([chainCodename, tokenCodename], index) =>
        LiqContractSteps.planRegliqpool<C>(
          Report.Actor.Sysio,
          `seed-liq-pool-${chainCodename.toLowerCase()}-${tokenCodename.toLowerCase()}`,
          `seed the ${tokenCodename}/WIRE yield pool on sysio.swap`,
          options,
          MockLiqPoolRegistrations[index]
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
      opp_inbound_addr: "",
      operator_registry_addr: "",
      source_deposit_addr: ""
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
        code: "ETHEREUM",
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
        code: "SOLANA",
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
        "LIQSOL",
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
      chainToken("ETHEREUM", "ETH", "", true),
      chainToken(
        "ETHEREUM",
        "LIQETH",
        nullableStrip(liqEthAddresses.LiqEthToken, strip0x),
        false
      ),
      chainToken(
        "ETHEREUM",
        "USDC",
        nullableStrip(ethereumAddresses.MockUsdc, strip0x),
        false
      ),
      chainToken(
        "ETHEREUM",
        "USDT",
        nullableStrip(ethereumAddresses.MockUsdt, strip0x),
        false
      ),
      chainToken("SOLANA", "SOL", "", true),
      chainToken(
        "SOLANA",
        "LIQSOL",
        nullableMintHex(solanaMints.LIQSOL),
        false
      ),
      chainToken("SOLANA", "USDCSOL", nullableMintHex(solanaMints.USDC), false),
      chainToken("SOLANA", "USDTSOL", nullableMintHex(solanaMints.USDT), false)
    ]
    await eachSeries(chainTokenBindings, data =>
      tokens.actions.regctok.invoke(data)
    )
  }

  // ── reserve-row builder (fully static — no deploy artifacts) ──

  /**
   * Build one static `regreserve` row for a (chain, token) PRIMARY reserve:
   * stablecoins carry native 6-dec precision + a ÷1000 chain seed, everything
   * else the depot's 9-dec frame. Byte-identical to the pre-split seeding.
   */
  function toReserveRegistration(
    chainCodename: string,
    tokenCodename: string,
    label: string
  ): SysioContracts.SysioReservRegreserveAction {
    const stable = StableCodenames.includes(tokenCodename)
    return {
      chain_code: chainCodename,
      token_code: tokenCodename,
      reserve_code: PrimaryReserveCodename,
      name: `${chainCodename}-${tokenCodename}/WIRE primary reserve`,
      description: `Bootstrap-seeded ${label} ↔ WIRE reserve`,
      initial_chain_amount: stable
        ? ReserveSeedAmount / StableChainSeedDivisor
        : ReserveSeedAmount,
      initial_wire_amount: ReserveSeedAmount,
      source_token_precision: stable
        ? StableTokenPrecision
        : DefaultTokenPrecision,
      connector_weight_bps: ConnectorWeightBps,
      is_private: false,
      owner: ""
    }
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
      precision: LiqTokenPrecision,
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
      ;["USDC", "USDT", "LIQSOL"].forEach(codename => {
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
