import Assert from "node:assert"

import {
  ClusterBuildPhase,
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapSource,
  convertImportSeedCredits,
  distributionClaimBootstrapCredit,
  FlowScenario,
  formatWireAsset,
  pollUntil,
  Report,
  sleep,
  Steps,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type DistributionClaimBootstrapOptions
} from "@wireio/cluster-tool"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"

import { EmissionsSoakScenarioConstants as Constants } from "./EmissionsSoakScenarioConstants.js"
import {
  ClaimantIdentitiesKey,
  ControlledClaimExpectationsKey,
  PreClaimBalancesKey,
  type ControlledClaimExpectations
} from "./EmissionsSoakScenarioOutputs.js"
import {
  buildControlledStakerIdentities,
  buildSyntheticEthereumDump,
  buildSyntheticSolanaDump
} from "./EmissionsSoakScenarioSyntheticDump.js"
import { EmissionsSoakScenarioSteps } from "./steps/EmissionsSoakScenarioSteps.js"

const log = getLogger(__filename)

const { SysioContractAccount, SysioContractName } = SysioContracts
const { Actor } = Report

/** Build the generic cluster bootstrap inputs the soak opts into by default. */
function createDistributionClaimBootstrapOptions(): DistributionClaimBootstrapOptions {
  const ethereumConversion = convertImportSeedCredits(
      buildSyntheticEthereumDump({
        seed: Constants.SyntheticSeed,
        purchaserCount: Constants.BulkEthereumPurchasers,
        stakerCount: Constants.BulkEthereumStakers,
        overlappingCount: Constants.BulkEthereumOverlapping,
        yieldClaimedCount: Constants.BulkEthereumYieldClaimed
      }),
      Constants.EthereumChain
    ),
    solanaConversion = convertImportSeedCredits(
      buildSyntheticSolanaDump({
        seed: Constants.SyntheticSeed + 1,
        purchaserCount: Constants.BulkSolanaPurchasers,
        stakerCount: Constants.BulkSolanaStakers
      }),
      Constants.SolanaChain
    ),
    identities = buildControlledStakerIdentities(
      Constants.ControlledStakerCount,
      Constants.ControlledStakerAccountPrefix,
      Constants.ControlledStakerEthereumHdIndexBase
    )
  return {
    fallbackCreditSets: [
      {
        chain: Constants.EthereumChain,
        source: DistributionClaimBootstrapSource.synthetic,
        credits: ethereumConversion.credits,
        droppedDust: ethereumConversion.droppedDust
      },
      {
        chain: Constants.SolanaChain,
        source: DistributionClaimBootstrapSource.synthetic,
        credits: solanaConversion.credits,
        droppedDust: solanaConversion.droppedDust
      }
    ],
    additiveCreditSets:
      identities.length === 0
        ? []
        : [
            {
              chain: Constants.EthereumChain,
              source: DistributionClaimBootstrapSource.controlled,
              credits: identities.map(identity => ({
                native_address: identity.addressHex,
                wire_atomic: Constants.ControlledStakerCreditAtomic
              })),
              droppedDust: 0n
            }
          ]
  }
}

/** The `sysio::t5state` singleton row (a read; asserts the row exists). */
async function readT5State(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioSystemT5StateType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.system)
    .tables.t5state.query()
  Assert.ok(rows.length >= 1, "sysio::t5state singleton row missing")
  return rows[0]
}

/** The `sysio::emitcfg` singleton row (a read; asserts the row exists). */
async function readEmissionConfig(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioSystemEmissionConfigType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.system)
    .tables.emitcfg.query()
  Assert.ok(rows.length >= 1, "sysio::emitcfg singleton row missing")
  return rows[0]
}

/** The `sysio.dclaim::capcfg` singleton row (a read; asserts the row exists). */
async function readCapConfig(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioDclaimCapConfigType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.dclaim)
    .tables.capcfg.query()
  Assert.ok(rows.length >= 1, "sysio.dclaim::capcfg singleton row missing")
  return rows[0]
}

/**
 * Emissions + `sysio.dclaim` Payout Soak — bootstraps a new cluster (the
 * bootstrap seeds the emissions config and imports either configured indexer
 * dumps or deterministic per-chain synthetic fallbacks, then drives a long
 * stretch of synced epochs to verify:
 *
 *   (a) **Stability** — the chain stays synced for the configured duration
 *       (default 30 min at 60s epochs ⇒ ~30 epochs; `SOAK_DURATION_MS`
 *       overrides; below ~5 min the sampling may not collect enough samples).
 *   (b) **Emissions accrual** — every `pay_cadence_epochs` boundary fires
 *       `payepoch`; `t5_state.total_distributed` advances monotonically and
 *       respects `t5_distributable - t5_floor`.
 *   (c) **importseed → link → claim** — controlled staker accounts (this flow
 *       holds their ETH wallets) complete AuthEx linking → an explicit
 *       `linkswept` sweeps `unmapped_tokens` into `pending_claims` → `claim`
 *       pays each staker its exact final merged WIRE credit. dclaim is
 *       pre-funded from `sysio` for those controlled obligations (importseed
 *       never calls
 *       `fundclaim`; only the onreward path does).
 *
 * **Out of scope:** `sysio.system::fundclaim` cap semantics — that path fires
 * only on `sysio.dclaim::onreward` (STAKING_REWARD attestations), pending the
 * outpost emission track. `capital_shortfall_total` is asserted `== 0`
 * throughout (trivially true today because no `fundclaim` calls occur).
 *
 * Phases: `ConfigureEmissions` → `SetupClaimers` → `StabilityLoop` → `Claim`.
 */
export class EmissionsSoakScenario extends FlowScenario {
  readonly name = "flow-emissions-soak"
  readonly description =
    "Emissions accrue monotonically over a multi-epoch soak while importseed-seeded stakers link and claim exact WIRE payouts"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    distributionClaimBootstrap: createDistributionClaimBootstrapOptions()
  }

  plan(cluster: ClusterBuild): void {
    const identities = buildControlledStakerIdentities(
        Constants.ControlledStakerCount,
        Constants.ControlledStakerAccountPrefix,
        Constants.ControlledStakerEthereumHdIndexBase
      ),
      bootstrap = cluster.context.outputs.assert(
        DistributionClaimBootstrapResultKey
      ),
      creditsByWireAccount = Object.fromEntries(
        identities.map(identity => [
          identity.wireAccount,
          distributionClaimBootstrapCredit(
            bootstrap,
            Constants.EthereumChain,
            identity.addressHex
          )
        ])
      ),
      expectations: ControlledClaimExpectations = {
        creditsByWireAccount,
        preFundAtomic: Object.values(creditsByWireAccount).reduce(
          (total, credit) => total + credit,
          0n
        )
      },
      actionOptions = { timeoutMs: Constants.ActionStepTimeoutMs },
      soakOptions = {
        timeoutMs: Constants.SoakDurationMs + Constants.SoakTimeoutMarginMs
      }
    cluster.context.outputs.set(ClaimantIdentitiesKey, identities)
    cluster.context.outputs.set(ControlledClaimExpectationsKey, expectations)

    // ── 1. ConfigureEmissions — the bootstrap seeds every emissions/dclaim
    //       config this flow needs; verify it landed as expected. ──
    ClusterBuildPhase.create(
      cluster,
      "ConfigureEmissions",
      "Verify the bootstrap-seeded emissions config + dclaim initialization"
    ).push(
      verifyStep(
        Actor.Sysio,
        "emissions-config",
        "emitcfg carries the expected compute/capex/governance splits + a live pay cadence",
        async ctx => {
          const config = await readEmissionConfig(ctx)
          Assert.strictEqual(
            config.compute_bps,
            Constants.ExpectedComputeBps,
            "compute_bps drifted"
          )
          Assert.strictEqual(
            config.capex_bps,
            Constants.ExpectedCapexBps,
            "capex_bps drifted"
          )
          Assert.strictEqual(
            config.governance_bps,
            Constants.ExpectedGovernanceBps,
            "governance_bps drifted"
          )
          Assert.ok(
            Number(config.pay_cadence_epochs) >= 1,
            "pay_cadence_epochs must be >= 1"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "dclaim-config",
        "capcfg exists with the import window closed and a positive claim window",
        async ctx => {
          const capConfig = await readCapConfig(ctx)
          // The table serializes bool as 0/1; coerce so the assertion is on
          // the logical value regardless of clio's encoding shape.
          Assert.strictEqual(
            Boolean(capConfig.imported_complete),
            true,
            "import window must be finalized by the shared bootstrap"
          )
          Assert.ok(
            capConfig.claim_window_sec > 0,
            "claim_window_sec must be positive"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "t5-state-initialized",
        "t5state exists with non-negative distribution and zero capital shortfall",
        async ctx => {
          const t5 = await readT5State(ctx)
          Assert.ok(
            Number(t5.total_distributed) >= 0,
            "total_distributed must be non-negative"
          )
          Assert.strictEqual(
            Number(t5.capital_shortfall_total),
            0,
            "capital_shortfall_total must start at 0"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "controlled-credits-exact",
        "every controlled staker has its exact final merged bootstrap credit",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            finalBootstrap = ctx.outputs.assert(
              DistributionClaimBootstrapResultKey
            ),
            finalExpectations = ctx.outputs.assert(
              ControlledClaimExpectationsKey
            )
          roster.forEach(identity => {
            const credit = distributionClaimBootstrapCredit(
                finalBootstrap,
                Constants.EthereumChain,
                identity.addressHex
              ),
              expected =
                finalExpectations.creditsByWireAccount[identity.wireAccount]
            Assert.ok(
              expected >= Constants.ControlledStakerCreditAtomic,
              `controlled staker ${identity.wireAccount} lost its additive credit`
            )
            Assert.strictEqual(
              credit,
              expected,
              `controlled staker ${identity.wireAccount} credit mismatch`
            )
          })
        }
      ),
      verifyStep(
        Actor.Sysio,
        "unmapped-populated",
        "unmapped_tokens holds at least one row per controlled staker",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            { rows } = await ctx.wire
              .getSysioContract(SysioContractName.dclaim)
              .tables.unmapped.query({ limit: Constants.UnmappedQueryLimit })
          Assert.ok(
            rows.length >= roster.length,
            `unmapped_tokens rows ${rows.length} < controlled stakers ${roster.length}`
          )
          log.info(`[soak] unmapped_tokens populated with ${rows.length} rows`)
        }
      )
    )

    // ── 2. SetupClaimers — pre-fund dclaim, provision each staker's WIRE
    //       account, authex-link its ETH wallet, sweep its credit. ──
    const preFundAsset = formatWireAsset(expectations.preFundAtomic)
    ClusterBuildPhase.create(
      cluster,
      "SetupClaimers",
      "Pre-fund dclaim + provision, link, and sweep every controlled staker"
    ).push(
      Steps.contracts.sysio.token.planTransfer(
        Actor.Sysio,
        "prefund-dclaim",
        `pre-fund sysio.dclaim with ${preFundAsset} for the controlled-staker obligations`,
        actionOptions,
        {
          from: SysioContractAccount[SysioContractName.system],
          to: SysioContractAccount[SysioContractName.dclaim],
          quantity: preFundAsset,
          memo: Constants.PreFundMemo
        }
      ),
      ...identities.map(identity =>
        EmissionsSoakScenarioSteps.planProvisionClaimer(
          Actor.User,
          `provision-${identity.wireAccount}`,
          `provision ${identity.wireAccount} (account + resource policy)`,
          actionOptions,
          identity.wireAccount
        )
      ),
      ...identities.map(identity =>
        EmissionsSoakScenarioSteps.planAuthexLink(
          Actor.User,
          `authex-link-${identity.wireAccount}`,
          `authex-link ${identity.wireAccount}'s ETH wallet (hd=${identity.ethereumHdIndex})`,
          actionOptions,
          identity
        )
      ),
      ...identities.map(identity =>
        EmissionsSoakScenarioSteps.planLinkswept(
          Actor.User,
          `linkswept-${identity.wireAccount}`,
          `sweep ${identity.wireAccount}'s unmapped credit into pending_claims`,
          actionOptions,
          identity.wireAccount,
          identity.addressHex
        )
      ),
      verifyStep(
        Actor.Sysio,
        "pending-claims-populated",
        "pending_claims rows land for every linked staker",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            linkedAccounts = new Set(
              roster.map(identity => identity.wireAccount)
            )
          await pollUntil(
            "pending_claims populated for all linked stakers",
            async () => {
              const { rows } = await ctx.wire
                .getSysioContract(SysioContractName.dclaim)
                .tables.pclaims.query()
              return (
                rows.filter(row => linkedAccounts.has(row.wire_account))
                  .length === roster.length
              )
            },
            Constants.PendingClaimsTimeoutMs,
            Constants.PendingClaimsPollIntervalMs
          )
        },
        {
          timeoutMs:
            Constants.PendingClaimsTimeoutMs + Constants.PollDeadlineBufferMs
        }
      )
    )

    // ── 3. StabilityLoop — sample t5state across the soak window; monotonic
    //       accrual, zero shortfall, headroom respected. ──
    ClusterBuildPhase.create(
      cluster,
      "StabilityLoop",
      `Sample t5state for ${Constants.SoakDurationMs}ms; monotonic accrual + zero shortfall`,
      [],
      soakOptions
    ).push(
      verifyStep(
        Actor.Sysio,
        "soak-monotonic-accrual",
        "total_distributed advances monotonically within headroom; capital_shortfall_total stays 0",
        async (ctx, signal) => {
          const emissionConfig = await readEmissionConfig(ctx),
            headroom =
              BigInt(emissionConfig.t5_distributable) -
              BigInt(emissionConfig.t5_floor),
            startT5 = await readT5State(ctx),
            startDistributed = BigInt(startT5.total_distributed),
            startWallMs = Date.now(),
            deadlineMs = startWallMs + Constants.SoakDurationMs
          let lastDistributed = startDistributed,
            sampleCount = 0
          while (Date.now() < deadlineMs && !signal.aborted) {
            await sleep(Constants.SampleIntervalMs)
            const t5 = await readT5State(ctx),
              distributed = BigInt(t5.total_distributed),
              shortfall = BigInt(t5.capital_shortfall_total),
              elapsedSec = Math.round((Date.now() - startWallMs) / 1000)
            log.info(
              `[soak] +${elapsedSec}s distributed=${distributed} shortfall=${shortfall}`
            )
            Assert.ok(
              distributed >= lastDistributed,
              `total_distributed regressed: ${distributed} < ${lastDistributed}`
            )
            Assert.strictEqual(
              shortfall,
              0n,
              "unexpected capital shortfall during the soak"
            )
            lastDistributed = distributed
            sampleCount += 1
          }
          Assert.ok(
            sampleCount >= 1,
            "soak window elapsed without collecting a single sample"
          )
          Assert.ok(
            lastDistributed <= headroom,
            `total_distributed ${lastDistributed} exceeds t5 headroom ${headroom}`
          )
          Assert.ok(
            lastDistributed > startDistributed,
            "no emissions accrued across the soak window"
          )
        },
        soakOptions
      )
    )

    // ── 4. Claim — snapshot balances, claim per staker, verify EXACT deltas
    //       and a still-zero capital shortfall. ──
    ClusterBuildPhase.create(
      cluster,
      "Claim",
      "Each controlled staker claims and receives its exact seeded WIRE"
    ).push(
      EmissionsSoakScenarioSteps.planUnlockWallet(
        Actor.User,
        "unlock-wallet-claim",
        "re-open + unlock the cluster wallet (kiod auto-locks across the soak)",
        actionOptions
      ),
      verifyStep(
        Actor.User,
        "snapshot-preclaim-balances",
        "record each staker's WIRE balance",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            entries = await Promise.all(
              roster.map(
                async identity =>
                  [
                    identity.wireAccount,
                    await ctx.wire.getWireBalance(identity.wireAccount)
                  ] as const
              )
            )
          ctx.outputs.set(PreClaimBalancesKey, Object.fromEntries(entries))
        }
      ),
      ...identities.map(identity =>
        EmissionsSoakScenarioSteps.planClaim(
          Actor.User,
          `claim-${identity.wireAccount}`,
          `${identity.wireAccount} claims its pending WIRE`,
          actionOptions,
          identity.wireAccount
        )
      ),
      verifyStep(
        Actor.User,
        "claim-deltas-exact",
        "each staker's WIRE balance grows by its final merged bootstrap credit",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            preClaimBalances = ctx.outputs.assert(PreClaimBalancesKey),
            finalExpectations = ctx.outputs.assert(
              ControlledClaimExpectationsKey
            )
          await Promise.all(
            roster.map(async identity => {
              const after = await ctx.wire.getWireBalance(identity.wireAccount),
                delta = after - preClaimBalances[identity.wireAccount],
                expected =
                  finalExpectations.creditsByWireAccount[identity.wireAccount]
              Assert.strictEqual(
                delta,
                expected,
                `claim delta for ${identity.wireAccount}: ${delta} != ${expected}`
              )
            })
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "final-shortfall-zero",
        "capital_shortfall_total is still 0 after every claim (no fundclaim calls on this path)",
        async ctx => {
          const t5 = await readT5State(ctx)
          Assert.strictEqual(
            BigInt(t5.capital_shortfall_total),
            0n,
            "capital_shortfall_total moved without an onreward-driven claim"
          )
        }
      )
    )
  }
}
