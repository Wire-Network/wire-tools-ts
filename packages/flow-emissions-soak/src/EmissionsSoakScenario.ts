import Assert from "node:assert"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  convertImportSeed,
  FlowScenario,
  formatWireAsset,
  pollUntil,
  Report,
  sleep,
  Steps,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/test-cluster-tool"
import { EmissionsSoakScenarioConstants as Constants } from "./EmissionsSoakScenarioConstants.js"
import {
  ClaimantIdentitiesKey,
  EthereumSeedConversionKey,
  PreClaimBalancesKey,
  toSeedConversionSummary
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
 * bootstrap seeds the emissions config + `dclaim::setconfig`), generates a
 * synthetic indexer dump in-flow (no committed fixtures, no live API call),
 * imports it via `sysio.dclaim::importseed`, then drives a long stretch of
 * synced epochs to verify:
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
 *       pays each staker its exact seeded WIRE. dclaim is pre-funded from
 *       `sysio` for the synthetic load (the importseed path never calls
 *       `fundclaim`; only the onreward path does).
 *
 * **Out of scope:** `sysio.system::fundclaim` cap semantics — that path fires
 * only on `sysio.dclaim::onreward` (STAKING_REWARD attestations), pending the
 * outpost emission track. `capital_shortfall_total` is asserted `== 0`
 * throughout (trivially true today because no `fundclaim` calls occur).
 *
 * Phases: `ConfigureEmissions` → `GenerateAndImport` → `SetupClaimers` →
 * `StabilityLoop` → `Claim`.
 */
export class EmissionsSoakScenario extends FlowScenario {
  readonly name = "flow-emissions-soak"
  readonly description =
    "Emissions accrue monotonically over a multi-epoch soak while importseed-seeded stakers link and claim exact WIRE payouts"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    // Pure value generation (no chain side effects): the synthetic corpus is
    // built here so the batch/staker step fan-out is known at registration
    // time — one write step per importseed batch, one per claimer action.
    const identities = buildControlledStakerIdentities(
        Constants.ControlledStakerCount,
        Constants.ControlledStakerAccountPrefix,
        Constants.ControlledStakerEthereumHdIndexBase
      ),
      ethereumDump = buildSyntheticEthereumDump({
        seed: Constants.SyntheticSeed,
        purchaserCount: Constants.BulkEthereumPurchasers,
        stakerCount: Constants.BulkEthereumStakers,
        overlappingCount: Constants.BulkEthereumOverlapping,
        yieldClaimedCount: Constants.BulkEthereumYieldClaimed,
        controlled: identities,
        controlledSourceUnits: Constants.ControlledStakerSourceUnits
      }),
      solanaDump = buildSyntheticSolanaDump({
        seed: Constants.SyntheticSeed + 1,
        purchaserCount: Constants.BulkSolanaPurchasers,
        stakerCount: Constants.BulkSolanaStakers
      }),
      ethereumConversion = toSeedConversionSummary(
        convertImportSeed(ethereumDump, { chain: Constants.EthereumChain })
      ),
      solanaConversion = toSeedConversionSummary(
        convertImportSeed(solanaDump, { chain: Constants.SolanaChain })
      ),
      actionOptions = { timeoutMs: Constants.ActionStepTimeoutMs },
      soakOptions = { timeoutMs: Constants.SoakDurationMs + Constants.SoakTimeoutMarginMs }

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
          Assert.strictEqual(config.compute_bps, Constants.ExpectedComputeBps, "compute_bps drifted")
          Assert.strictEqual(config.capex_bps, Constants.ExpectedCapexBps, "capex_bps drifted")
          Assert.strictEqual(
            config.governance_bps,
            Constants.ExpectedGovernanceBps,
            "governance_bps drifted"
          )
          Assert.ok(Number(config.pay_cadence_epochs) >= 1, "pay_cadence_epochs must be >= 1")
        }
      ),
      verifyStep(
        Actor.Sysio,
        "dclaim-config",
        "capcfg exists with the import window open and a positive claim window",
        async ctx => {
          const capConfig = await readCapConfig(ctx)
          // The table serializes bool as 0/1; coerce so the assertion is on
          // the logical value regardless of clio's encoding shape.
          Assert.strictEqual(
            Boolean(capConfig.imported_complete),
            false,
            "import window must still be open at bootstrap"
          )
          Assert.ok(capConfig.claim_window_sec > 0, "claim_window_sec must be positive")
        }
      ),
      verifyStep(
        Actor.Sysio,
        "t5-state-initialized",
        "t5state exists with non-negative distribution and zero capital shortfall",
        async ctx => {
          const t5 = await readT5State(ctx)
          Assert.ok(Number(t5.total_distributed) >= 0, "total_distributed must be non-negative")
          Assert.strictEqual(
            Number(t5.capital_shortfall_total),
            0,
            "capital_shortfall_total must start at 0"
          )
        }
      )
    )

    // ── 2. GenerateAndImport — seed dclaim from the synthetic dumps, one
    //       write step per importseed batch, then close the import window. ──
    ClusterBuildPhase.create(
      cluster,
      "GenerateAndImport",
      "Convert the synthetic dumps and seed dclaim via importseed + importdone"
    ).push(
      EmissionsSoakScenarioSteps.planUnlockWallet(
        Actor.Sysio,
        "unlock-wallet-import",
        "open + unlock the cluster wallet for the import burst",
        actionOptions
      ),
      EmissionsSoakScenarioSteps.planPublishSeedData(
        Actor.Sysio,
        "publish-seed-data",
        "publish the controlled-staker roster + converted importseed batches",
        {},
        identities,
        ethereumConversion,
        solanaConversion
      ),
      verifyStep(
        Actor.Sysio,
        "controlled-credits-exact",
        "every controlled staker survives conversion with the exact atomic credit",
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            conversion = ctx.outputs.assert(EthereumSeedConversionKey),
            credits = conversion.batches.flatMap(batch => batch.credits),
            expectedAtomic = Constants.PerStakerClaimAtomic.toString()
          roster.forEach(identity => {
            const credit = credits.find(
              candidate => candidate.native_address === identity.addressHex
            )
            Assert.ok(
              credit != null,
              `controlled staker ${identity.wireAccount} missing from the importseed credits`
            )
            Assert.strictEqual(
              credit.wire_atomic,
              expectedAtomic,
              `controlled staker ${identity.wireAccount} credit mismatch`
            )
          })
        }
      ),
      ...ethereumConversion.batches.map((batch, index) =>
        EmissionsSoakScenarioSteps.planImportSeedBatch(
          Actor.Sysio,
          `import-ethereum-batch-${index + 1}`,
          `push importseed ETH batch ${index + 1}/${ethereumConversion.batches.length} (${batch.credits.length} credits)`,
          actionOptions,
          Constants.EthereumChain,
          index,
          batch.credits.length
        )
      ),
      ...solanaConversion.batches.map((batch, index) =>
        EmissionsSoakScenarioSteps.planImportSeedBatch(
          Actor.Sysio,
          `import-solana-batch-${index + 1}`,
          `push importseed SOL batch ${index + 1}/${solanaConversion.batches.length} (${batch.credits.length} credits)`,
          actionOptions,
          Constants.SolanaChain,
          index,
          batch.credits.length
        )
      ),
      EmissionsSoakScenarioSteps.planImportDone(
        Actor.Sysio,
        "import-done",
        "close the import window (sysio.dclaim::importdone)",
        actionOptions
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

    // ── 3. SetupClaimers — pre-fund dclaim, provision each staker's WIRE
    //       account, authex-link its ETH wallet, sweep its credit. ──
    const preFundAsset = formatWireAsset(Constants.ClaimPreFundAtomic)
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
            linkedAccounts = new Set(roster.map(identity => identity.wireAccount))
          await pollUntil(
            "pending_claims populated for all linked stakers",
            async () => {
              const { rows } = await ctx.wire
                .getSysioContract(SysioContractName.dclaim)
                .tables.pclaims.query()
              return (
                rows.filter(row => linkedAccounts.has(row.wire_account)).length === roster.length
              )
            },
            Constants.PendingClaimsTimeoutMs,
            Constants.PendingClaimsPollIntervalMs
          )
        },
        { timeoutMs: Constants.PendingClaimsTimeoutMs + Constants.PollDeadlineBufferMs }
      )
    )

    // ── 4. StabilityLoop — sample t5state across the soak window; monotonic
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
            headroom = BigInt(emissionConfig.t5_distributable) - BigInt(emissionConfig.t5_floor),
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
            log.info(`[soak] +${elapsedSec}s distributed=${distributed} shortfall=${shortfall}`)
            Assert.ok(
              distributed >= lastDistributed,
              `total_distributed regressed: ${distributed} < ${lastDistributed}`
            )
            Assert.strictEqual(shortfall, 0n, "unexpected capital shortfall during the soak")
            lastDistributed = distributed
            sampleCount += 1
          }
          Assert.ok(sampleCount >= 1, "soak window elapsed without collecting a single sample")
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

    // ── 5. Claim — snapshot balances, claim per staker, verify EXACT deltas
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
      verifyStep(Actor.User, "snapshot-preclaim-balances", "record each staker's WIRE balance", async ctx => {
        const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
          entries = await Promise.all(
            roster.map(
              async identity =>
                [identity.wireAccount, await ctx.wire.getWireBalance(identity.wireAccount)] as const
            )
          )
        ctx.outputs.set(PreClaimBalancesKey, Object.fromEntries(entries))
      }),
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
        `each staker's WIRE balance grows by exactly ${Constants.PerStakerClaimAtomic} atomic`,
        async ctx => {
          const roster = ctx.outputs.assert(ClaimantIdentitiesKey),
            preClaimBalances = ctx.outputs.assert(PreClaimBalancesKey)
          await Promise.all(
            roster.map(async identity => {
              const after = await ctx.wire.getWireBalance(identity.wireAccount),
                delta = after - preClaimBalances[identity.wireAccount]
              Assert.strictEqual(
                delta,
                Constants.PerStakerClaimAtomic,
                `claim delta for ${identity.wireAccount}: ${delta} != ${Constants.PerStakerClaimAtomic}`
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
