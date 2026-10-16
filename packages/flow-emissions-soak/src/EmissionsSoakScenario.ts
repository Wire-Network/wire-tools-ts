import Assert from "node:assert"
import { EthereumDeploymentKind } from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  FlowScenario,
  pollUntil,
  Report,
  sleep,
  Steps,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { EmissionsSoakScenarioConstants as Constants } from "./EmissionsSoakScenarioConstants.js"
import { PreClaimBalancesKey } from "./EmissionsSoakScenarioOutputs.js"
import { EmissionsSoakScenarioSteps } from "./steps/EmissionsSoakScenarioSteps.js"

const log = getLogger(__filename)

const { SysioContractName } = SysioContracts
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
 * Emissions + `sysio.dclaim` Payout Soak — bootstraps a ladder cluster: the
 * pre-launch Ethereum outpost is deployed, used and frozen, and the bootstrap
 * imports its capital-index snapshot, which seeds `sysio.dclaim` with the
 * pre-launch buyers' pretokens and seals the import. The flow then drives a
 * long stretch of synced epochs to verify:
 *
 *   (a) **Stability** — the chain stays synced for the configured duration
 *       (default 30 min at 60s epochs ⇒ ~30 epochs; `SOAK_DURATION_MS`
 *       overrides; below ~5 min the sampling may not collect enough samples).
 *   (b) **Emissions accrual** — every `pay_cadence_epochs` boundary fires
 *       `payepoch`; `t5_state.total_distributed` advances monotonically and
 *       respects `t5_distributable - t5_floor`.
 *   (c) **seed → link → claim** — each pre-launch buyer (the harness holds
 *       its key) links its Ethereum key to a new WIRE account, whose inline
 *       `linkswept` sweeps its `unmapped_tokens` row into `pending_claims` →
 *       `claim` pays it exactly the WIRE the import seeded. dclaim is
 *       pre-funded from `sysio` with exactly those credits.
 *
 * Phases: `ConfigureEmissions` → `LadderSeed` → `SetupClaimers` →
 * `StabilityLoop` → `Claim`.
 */
export class EmissionsSoakScenario extends FlowScenario {
  readonly name = "flow-emissions-soak"
  readonly description =
    "Emissions accrue monotonically over a multi-epoch soak while the pre-launch buyers the ladder import seeded link and claim exact WIRE payouts"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    // The dclaim seed is the frozen pre-launch outpost's, imported at bootstrap.
    ethereumDeployment: EthereumDeploymentKind.ladder
  }

  plan(cluster: ClusterBuild): void {
    const claimants = Constants.claimants(),
      actionOptions = { timeoutMs: Constants.ActionStepTimeoutMs },
      soakOptions = {
        timeoutMs: Constants.SoakDurationMs + Constants.SoakTimeoutMarginMs
      }

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
        "capcfg exists with the import window sealed by the ladder import",
        async ctx => {
          const capConfig = await readCapConfig(ctx)
          // The table serializes bool as 0/1; coerce so the assertion is on
          // the logical value regardless of clio's encoding shape.
          Assert.strictEqual(
            Boolean(capConfig.imported_complete),
            true,
            "the bootstrap's ladder import must have sealed the dclaim window"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "t5-state-initialized",
        "t5state exists with non-negative distribution",
        async ctx => {
          const t5 = await readT5State(ctx)
          Assert.ok(
            Number(t5.total_distributed) >= 0,
            "total_distributed must be non-negative"
          )
        }
      )
    )

    // ── 2. LadderSeed — the bootstrap's import seeded every pre-launch buyer. ──
    ClusterBuildPhase.create(
      cluster,
      "LadderSeed",
      "Every pre-launch buyer has a dclaim credit from the ladder import, parked in unmapped_tokens"
    ).push(
      verifyStep(
        Actor.Sysio,
        "claimant-credits-seeded",
        "the ladder import seeded a non-zero WIRE credit for every pre-launch buyer",
        async ctx => {
          claimants.forEach(claimant => {
            const atomic = EmissionsSoakScenarioSteps.seededAtomic(ctx, claimant)
            Assert.ok(
              atomic > 0n,
              `pre-launch buyer ${claimant.actorIndex} was seeded no WIRE`
            )
            log.info(`[soak] ${claimant.wireAccount} seeded ${atomic} atomic`)
          })
        }
      ),
      verifyStep(
        Actor.Sysio,
        "unmapped-populated",
        "unmapped_tokens holds at least one row per claimant",
        async ctx => {
          const { rows } = await ctx.wire
            .getSysioContract(SysioContractName.dclaim)
            .tables.unmapped.query({ limit: Constants.UnmappedQueryLimit })
          Assert.ok(
            rows.length >= claimants.length,
            `unmapped_tokens rows ${rows.length} < claimants ${claimants.length}`
          )
          log.info(`[soak] unmapped_tokens populated with ${rows.length} rows`)
        }
      )
    )

    // ── 3. SetupClaimers — pre-fund dclaim with exactly the claimants' credits,
    //       provision each claimant's WIRE account, link its Ethereum key. ──
    ClusterBuildPhase.create(
      cluster,
      "SetupClaimers",
      "Pre-fund dclaim + provision and link every claimant"
    ).push(
      EmissionsSoakScenarioSteps.planUnlockWallet(
        Actor.Sysio,
        "unlock-wallet-setup",
        "open + unlock the cluster wallet for the setup burst",
        actionOptions
      ),
      EmissionsSoakScenarioSteps.planPrefundDclaim(
        Actor.Sysio,
        "prefund-dclaim",
        "pre-fund sysio.dclaim with exactly the claimants' seeded WIRE",
        actionOptions,
        claimants
      ),
      ...claimants.map(claimant =>
        EmissionsSoakScenarioSteps.planProvisionClaimer(
          Actor.User,
          `provision-${claimant.wireAccount}`,
          `provision ${claimant.wireAccount} (account + resource policy)`,
          actionOptions,
          claimant.wireAccount
        )
      ),
      ...claimants.map(claimant =>
        Steps.ethereumLadderImport.planLinkActor(
          Actor.User,
          `authex-link-${claimant.wireAccount}`,
          `authex-link ${claimant.wireAccount} to pre-launch buyer ${claimant.actorIndex}'s Ethereum key`,
          actionOptions,
          claimant.actorIndex,
          claimant.wireAccount
        )
      ),
      verifyStep(
        Actor.Sysio,
        "pending-claims-populated",
        "pending_claims rows land for every linked claimant",
        async ctx => {
          const linkedAccounts = new Set(
            claimants.map(claimant => claimant.wireAccount)
          )
          await pollUntil(
            "pending_claims populated for all linked claimants",
            async () => {
              const { rows } = await ctx.wire
                .getSysioContract(SysioContractName.dclaim)
                .tables.pclaims.query()
              return (
                rows.filter(row => linkedAccounts.has(row.wire_account))
                  .length === claimants.length
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

    // ── 4. StabilityLoop — sample t5state across the soak window; monotonic
    //       accrual, headroom respected. ──
    ClusterBuildPhase.create(
      cluster,
      "StabilityLoop",
      `Sample t5state for ${Constants.SoakDurationMs}ms; monotonic accrual within headroom`,
      [],
      soakOptions
    ).push(
      verifyStep(
        Actor.Sysio,
        "soak-monotonic-accrual",
        "total_distributed advances monotonically within headroom",
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
              elapsedSec = Math.round((Date.now() - startWallMs) / 1000)
            log.info(`[soak] +${elapsedSec}s distributed=${distributed}`)
            Assert.ok(
              distributed >= lastDistributed,
              `total_distributed regressed: ${distributed} < ${lastDistributed}`
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

    // ── 5. Claim — snapshot balances, claim per staker, verify EXACT deltas
    //       and treasury distribution within headroom. ──
    ClusterBuildPhase.create(
      cluster,
      "Claim",
      "Each claimant claims and receives its exact seeded WIRE"
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
        "record each claimant's WIRE balance",
        async ctx => {
          const entries = await Promise.all(
            claimants.map(
              async claimant =>
                [
                  claimant.wireAccount,
                  await ctx.wire.getWireBalance(claimant.wireAccount)
                ] as const
            )
          )
          ctx.outputs.set(PreClaimBalancesKey, Object.fromEntries(entries))
        }
      ),
      ...claimants.map(claimant =>
        EmissionsSoakScenarioSteps.planClaim(
          Actor.User,
          `claim-${claimant.wireAccount}`,
          `${claimant.wireAccount} claims its pending WIRE`,
          actionOptions,
          claimant.wireAccount
        )
      ),
      verifyStep(
        Actor.User,
        "claim-deltas-exact",
        "each claimant's WIRE balance grows by exactly the WIRE the ladder import seeded",
        async ctx => {
          const preClaimBalances = ctx.outputs.assert(PreClaimBalancesKey)
          await Promise.all(
            claimants.map(async claimant => {
              const seeded = EmissionsSoakScenarioSteps.seededAtomic(ctx, claimant),
                after = await ctx.wire.getWireBalance(claimant.wireAccount),
                delta = after - preClaimBalances[claimant.wireAccount]
              Assert.strictEqual(
                delta,
                seeded,
                `claim delta for ${claimant.wireAccount}: ${delta} != ${seeded}`
              )
            })
          )
        }
      )
    )
  }
}
