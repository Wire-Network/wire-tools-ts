import Path from "node:path"
import { chunk, range } from "lodash"
import { KeyType } from "@wireio/sdk-core"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { BatchOperatorSchedule } from "../../config/BatchOperatorSchedule.js"
import { Report } from "../../report/Report.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { KeySteps } from "../steps/KeySteps.js"
import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostInitialRoster
} from "./EthereumOutpostBootstrapper.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"

/** Steps that deploy + seed the Ethereum (anvil) outpost. */
export namespace EthereumOutpostSteps {
  /** Subpath (under the cluster data dir) for the annotated accounts file. */
  const AnvilDataSubpath = "anvil"

  /**
   * Derive the WNE-41 initial batch-operator roster the outpost is constructed
   * with — the ETH addresses of every bootstrapped batch operator, grouped the
   * way the depot's `schbatchgps` will group them.
   *
   * The addresses are DERIVED rather than read off provisioned operators
   * because the outpost deploys in **Cluster Prerequisites**, while the batch
   * operators are provisioned later in **Cluster Post Contract Deployment**.
   * The (mnemonic, HD index) pair is fully determined by then, and both sides
   * read it from the SAME two authorities — {@link KeySteps.ethereumMnemonic}
   * and {@link Constants.batchOperatorEthereumHdIndex} — so the roster cannot
   * disagree with the keys the daemons later sign `epochIn` with.
   *
   * `groups[0].length` is the outpost's consensus threshold, so the grouping is
   * sized by the depot's own `operators_per_epoch` from
   * {@link BatchOperatorSchedule.resolve}. Membership in the later groups grants
   * delivery rights without raising that threshold; the depot replaces the whole
   * roster with its real schedule on the first BATCH_OPERATOR_GROUPS
   * attestation.
   *
   * @param ctx - The build context.
   * @returns The initial roster for `OPPInbound.initialize`.
   */
  export async function resolveInitialRoster<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<EthereumOutpostInitialRoster> {
    const { config } = ctx,
      { operatorsPerEpoch, batchOpGroups, batchOperatorMinimumActive } =
        BatchOperatorSchedule.resolve(config),
      keyContext = KeyGenerator.context(
        config.executables.clio,
        config.buildPath,
        KeySteps.ethereumMnemonic(ctx)
      ),
      // Walk the BATCH-OPERATOR LABEL list — an array already narrowed to
      // `batchop.` entries — and take that filtered array's iterator index.
      // The provisioning side (`ClusterBuildDefaults`) assigns each operator's
      // HD index the same way, so the roster authorizes exactly the addresses
      // the daemons later sign `epochIn` with. Indexing a bare
      // `range(batchOperatorCount)` would agree only by coincidence of
      // ordering; neither the position nor the sort order of an operator in a
      // persisted `cluster-keys.json` is guaranteed, so the ordinal is only
      // meaningful once the list has been filtered by label prefix.
      batchOperatorLabels = range(config.batchOperatorCount).map(index =>
        Constants.batchOperatorLabel(index)
      ),
      addresses = await mapSeries(
        batchOperatorLabels,
        async (label, index) =>
          (
            await KeyGenerator.create(KeyType.EM, keyContext, {
              ethereumHdIndex: Constants.batchOperatorEthereumHdIndex(index),
              purpose: `ethereum-outpost initial batch-operator roster (${label})`
            })
          ).address
      )
    return {
      groups: partitionLikeDepot(
        addresses,
        operatorsPerEpoch,
        batchOpGroups,
        batchOperatorMinimumActive
      ),
      epochDurationSec: config.epochDurationSec
    }
  }

  /**
   * Partition roster addresses into groups the way `sysio.epoch::schbatchgps`
   * does, so the outpost starts life with the shape the depot will replace it
   * with on its first `BATCH_OPERATOR_GROUPS` attestation.
   *
   * Mirrors the depot's steps in order: TRIM the pool to
   * `batch_operator_minimum_active`, EVEN/ODD INTERLEAVE it, then partition
   * into exactly `batch_op_groups` groups of `operators_per_epoch`.
   *
   * The interleave is what spreads bootstrapped and non-bootstrapped operators
   * across groups on the depot; reproducing it here keeps group 0 — whose
   * length IS the outpost's consensus threshold — the same SIZE the depot will
   * install. Group MEMBERSHIP cannot be reproduced: the depot orders by
   * on-chain account name, which is generated later in the bootstrap and does
   * not exist when the outpost is deployed. Membership is not load-bearing for
   * epoch 1 — `isActiveOperator` scans every group — but the threshold is.
   *
   * @param addresses - Roster addresses in batch-operator label order.
   * @param operatorsPerEpoch - Depot `operators_per_epoch` (group SIZE).
   * @param batchOpGroups - Depot `batch_op_groups` (group COUNT).
   * @param batchOperatorMinimumActive - Depot `batch_operator_minimum_active`.
   * @returns Exactly `batchOpGroups` non-empty groups.
   */
  export function partitionLikeDepot(
    addresses: string[],
    operatorsPerEpoch: number,
    batchOpGroups: number,
    batchOperatorMinimumActive: number
  ): string[][] {
    // TRIM — the depot schedules only `batch_operator_minimum_active` of the
    // ACTIVE pool; anything past it stays ACTIVE but ungrouped there.
    const scheduled = addresses.slice(0, batchOperatorMinimumActive),
      // INTERLEAVE — evens then odds, exactly as `schbatchgps` shuffles.
      interleaved = [
        ...scheduled.filter((_address, index) => index % 2 === 0),
        ...scheduled.filter((_address, index) => index % 2 === 1)
      ],
      scheduledGroups = range(batchOpGroups)
        .map(group =>
          interleaved.slice(
            group * operatorsPerEpoch,
            group * operatorsPerEpoch + operatorsPerEpoch
          )
        )
        // The contract rejects an EMPTY group, so a short pool yields fewer
        // groups rather than padded ones.
        .filter(group => group.length > 0),
      // Operators past the depot's scheduled window still need delivery rights
      // on epoch 1 — `isActiveOperator` scans every group. They ride groups of
      // their OWN and are never merged into an existing one: with a single
      // scheduled group the "last" group IS group 0, and widening that raises
      // the consensus threshold to a number no epoch can meet.
      overflowGroups = chunk(
        addresses.slice(batchOperatorMinimumActive),
        operatorsPerEpoch
      )
    return [...scheduledGroups, ...overflowGroups]
  }

  /**
   * Deploy the Ethereum outpost against the already-running run anvil
   * (`Steps.processes.anvil.start` must precede this in the phase): deploy the
   * `wire-ethereum` contracts, seed the ReserveManager, and write the annotated
   * accounts file (later phases re-read `accounts.json` / `outpost-addrs.json`
   * from disk). Input-less — paths + the anvil port come from `ctx.config`.
   */
  export function planDeploy<
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
      runDeploy
    )
  }

  /** Named runner — `EthereumOutpostBootstrapper.bootstrap` against the run anvil. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // Same derivation as AnvilProcess.rpcUrl — the run anvil was bound to this
    // exact port by Steps.processes.anvil.start, so they cannot diverge.
    await new EthereumOutpostBootstrapper({
      ethereumPath: ctx.config.ethereumPath,
      anvilDataPath: Path.join(ctx.config.dataPath, AnvilDataSubpath),
      rpcUrl: toURL(
        ctx.config.bind.anvil.port,
        toDialAddress(ctx.config.bind.anvil.address)
      ),
      deploymentsPath: ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      initialRoster: await resolveInitialRoster(ctx)
    }).bootstrap()
  }
}
