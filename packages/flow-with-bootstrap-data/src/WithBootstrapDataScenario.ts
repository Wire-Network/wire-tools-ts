import Assert from "node:assert"

import { ChainKind } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapSource,
  FlowScenario,
  Report,
  distributionClaimBootstrapCredit,
  formatWireAsset,
  matchesProtoEnum,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type DistributionClaimBootstrapChainResult
} from "@wireio/cluster-tool"

import { WithBootstrapDataScenarioConstants as Constants } from "./WithBootstrapDataScenarioConstants.js"

const { SysioContractName, SysioDclaimChainkind } = SysioContracts
const { Actor } = Report

/** Find the prepared bootstrap summary for one native chain. */
function bootstrapChain(
  ctx: ClusterBuildContext,
  chain: ChainKind.EVM | ChainKind.SVM
): DistributionClaimBootstrapChainResult {
  const result = ctx.outputs.assert(DistributionClaimBootstrapResultKey),
    chainResult = result.chains.find(candidate => candidate.chain === chain)
  Assert.ok(chainResult != null, `bootstrap result omitted chain ${chain}`)
  return chainResult
}

/**
 * Fixture-driven acceptance flow for OPS-197. A real cluster imports both
 * committed indexer-shaped dumps during bootstrap, then the flow verifies the
 * deterministic plan and the exact persisted `sysio.dclaim` state.
 */
export class WithBootstrapDataScenario extends FlowScenario {
  readonly name = "flow-with-bootstrap-data"
  readonly description =
    "Import committed Ethereum and Solana balance fixtures into sysio.dclaim during cluster bootstrap"

  override readonly defaults: ClusterBuildOptions = {
    ethereum: {
      bootstrapJsonFile: Constants.EthereumBootstrapJsonFile
    },
    solana: {
      bootstrapJsonFile: Constants.SolanaBootstrapJsonFile
    }
  }

  plan(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "VerifyBootstrapData",
      "Verify fixture conversion, import finalization, and exact on-chain credits"
    ).push(
      verifyStep(
        Actor.Sysio,
        "prepared-bootstrap-plan",
        "the finalized plan contains only the exact committed fixture credits",
        async ctx => {
          const result = ctx.outputs.assert(DistributionClaimBootstrapResultKey)
          Assert.strictEqual(
            result.chains.length,
            Constants.ExpectedChains.length,
            "unexpected bootstrap chain count"
          )
          Constants.ExpectedChains.forEach(expected => {
            const actual = bootstrapChain(ctx, expected.chain)
            Assert.deepStrictEqual(actual.sources, [
              DistributionClaimBootstrapSource.configuredFile
            ])
            Assert.strictEqual(
              actual.eligibleAddressCount,
              expected.eligibleAddressCount
            )
            Assert.strictEqual(actual.totalAtomic, expected.totalAtomic)
            Assert.strictEqual(actual.droppedDust, expected.droppedDust)
            Assert.strictEqual(
              actual.batches.length,
              Constants.ExpectedBatchCountPerChain
            )
          })
          Constants.ExpectedCredits.forEach(expected => {
            Assert.strictEqual(
              distributionClaimBootstrapCredit(
                result,
                expected.chain,
                expected.nativeAddress
              ),
              expected.wireAtomic,
              `prepared credit mismatch for ${expected.nativeAddress}`
            )
          })
        }
      ),
      verifyStep(
        Actor.Sysio,
        "import-window-closed",
        "sysio.dclaim records that bootstrap import is complete",
        async ctx => {
          const { rows } = await ctx.wire
            .getSysioContract(SysioContractName.dclaim)
            .tables.capcfg.query({ limit: 1 })
          Assert.ok(rows.length === 1, "sysio.dclaim::capcfg row missing")
          Assert.strictEqual(
            Boolean(rows[0].imported_complete),
            true,
            "dclaim import window remained open"
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "fixture-credits-imported",
        "every fixture address has its exact chain and WIRE balance in unmapped_tokens",
        async ctx => {
          const { rows } = await ctx.wire
            .getSysioContract(SysioContractName.dclaim)
            .tables.unmapped.query({ limit: Constants.UnmappedQueryLimit })
          Assert.strictEqual(
            rows.length,
            Constants.ExpectedCredits.length,
            "unexpected sysio.dclaim::unmapped row count"
          )
          Constants.ExpectedCredits.forEach(expected => {
            const row = rows.find(
              candidate =>
                candidate.native_pubkey.toLowerCase() === expected.nativeAddress
            )
            Assert.ok(
              row != null,
              `unmapped credit missing for ${expected.nativeAddress}`
            )
            Assert.ok(
              matchesProtoEnum(
                row.chain_kind,
                SysioDclaimChainkind,
                expected.chain
              ),
              `chain kind mismatch for ${expected.nativeAddress}`
            )
            Assert.strictEqual(
              row.balance,
              formatWireAsset(expected.wireAtomic),
              `balance mismatch for ${expected.nativeAddress}`
            )
          })
        }
      )
    )
  }
}
