import Assert from "node:assert"

import * as anchor from "@coral-xyz/anchor"
import { PublicKey } from "@solana/web3.js"
import { Name } from "@wireio/sdk-core"
import { OperatorStatus, OperatorType } from "@wireio/opp-typescript-models"

import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { solanaNativePublicKey } from "../../utils/keyPairUtils.js"
import { OperatorAccount } from "../outputs/OperatorAccount.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { EpochContractSteps } from "../steps/contracts/sysio/EpochContractSteps.js"
import { SolanaOutpostBootstrapper } from "./SolanaOutpostBootstrapper.js"

const log = getLogger(__filename)

/** Steps that deploy + seed the Solana (test-validator) outpost. */
export namespace SolanaOutpostSteps {
  /**
   * Largest operator roster {@link resolveOppBootstrapSeed} will seed through
   * `opp_bootstrap`. The instruction carries the roster AND the group in ONE
   * legacy transaction, and that packet — not
   * {@link SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers}, the looser
   * Anchor encode-buffer ceiling — is the binding limit at roughly 11 members.
   * A depot group larger than this is TRIMMED to its first
   * `MaxOppBootstrapOperators` members, which only LOWERS the outpost's seeded
   * consensus threshold (`ceil(n / 2)`); it can never seed more signers than
   * the depot's delivering set. The seed is transient either way — the depot's
   * first `BatchOperatorGroups` attestation installs the authoritative roster
   * under consensus. Raising this walks back toward the packet limit.
   */
  export const MaxOppBootstrapOperators = 5

  /**
   * Deploy the Solana outpost: airdrop the deployer, initialize the opp-outpost
   * PDAs against the already-loaded program, seed the native-SOL reserve, and
   * provision mock SPL reserves (persisting `sol-mock-mints.json` for depot-side
   * token registration). Input-less — paths + RPC come from `ctx.config` /
   * `ctx.solana`; the validator must already be running.
   */
  export function planDeploy<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runDeploy)
  }

  /** Named runner — `SolanaOutpostBootstrapper.bootstrap`. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await new SolanaOutpostBootstrapper({
      solanaPath: ctx.config.solanaPath,
      rpcUrl: ctx.solana.rpcUrl,
      clusterDataPath: ctx.config.dataPath
    }).bootstrap()
  }

  /**
   * Seed the Solana outpost's first operator roster + signable group via
   * `opp_bootstrap` (SOL-376). The outpost's `epoch_in` refuses to finalize
   * until this runs, so it is sequenced AFTER the depot's `schbatchgps` has
   * materialized the epoch-1 batch-operator group and BEFORE the depot delivers
   * its first envelope. Input-less — the roster + group are resolved from
   * `ctx.keyStore` and the depot's `sysio.epoch::epochstate`.
   */
  export function planOppBootstrap<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runOppBootstrap)
  }

  /** Named runner — `SolanaOutpostBootstrapper.oppBootstrap`. */
  export async function runOppBootstrap<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()

    const batchOperators = ctx.keyStore.operatorsByType(OperatorType.BATCH)

    // The SEED GROUP tracks the depot's epoch-1 batch-operator group (its size
    // drives the outpost's consensus threshold): the depot materializes the
    // schedule into `epochstate.batch_op_groups`, active at index
    // `current_batch_op_group`. `resolveOppBootstrapSeed` trims it to
    // `MaxOppBootstrapOperators` so the seed always fits one transaction.
    const groupAccounts = await EpochContractSteps.activeBatchOperatorGroup(ctx)
    Assert.ok(
      groupAccounts != null && groupAccounts.length > 0,
      "runOppBootstrap: epoch-1 batch-operator group is empty"
    )

    await new SolanaOutpostBootstrapper({
      solanaPath: ctx.config.solanaPath,
      rpcUrl: ctx.solana.rpcUrl,
      clusterDataPath: ctx.config.dataPath
    }).oppBootstrap(
      resolveOppBootstrapSeed(batchOperators, groupAccounts),
      ctx.config.epochDurationSec
    )
  }

  /**
   * Build the `opp_bootstrap` seed from the provisioned batch operators and the
   * depot's epoch-1 group account names. BOTH halves derive from
   * `groupAccounts`: the ROSTER is exactly the group's operators (see
   * {@link SolanaOutpostBootstrapper.OppBootstrapSeed.operators} for why it
   * stays group-bounded), and the GROUP is their SOL pubkeys — its size drives
   * the outpost's consensus threshold, so it tracks the depot's delivering set.
   *
   * The group is trimmed to its first {@link MaxOppBootstrapOperators} members
   * (logged, never silent) because `opp_bootstrap` ships the roster and the
   * group in ONE transaction. Accounts past the cap are never resolved, so a
   * member beyond it that is unprovisioned or SOL-keyless does not fail the
   * seed.
   *
   * @param batchOperators - every provisioned batch operator (from `ctx.keyStore`).
   * @param groupAccounts - the depot's epoch-1 group account names.
   * @return the capped, group-bounded roster + group-member SOL pubkeys for
   *   `opp_bootstrap`.
   * @throws if a SEEDED group account is not among the provisioned batch
   *   operators or its operator lacks a Solana key.
   */
  export function resolveOppBootstrapSeed(
    batchOperators: OperatorAccount[],
    groupAccounts: string[]
  ): SolanaOutpostBootstrapper.OppBootstrapSeed {
    const seedAccounts = groupAccounts.slice(0, MaxOppBootstrapOperators)
    if (seedAccounts.length < groupAccounts.length) {
      log.warn(
        `resolveOppBootstrapSeed: trimming the epoch-1 group from ${groupAccounts.length} to ` +
          `${MaxOppBootstrapOperators} seeded operators — opp_bootstrap carries the roster AND the ` +
          `group in one transaction; the depot's first BatchOperatorGroups attestation installs the ` +
          `full roster under consensus`
      )
    }

    const operatorByAccount = new Map(batchOperators.map(operator => [operator.account, operator])),
      groupOperators = seedAccounts.map(accountName => {
        const operator = operatorByAccount.get(accountName)
        Assert.ok(
          operator,
          `resolveOppBootstrapSeed: epoch-1 group member ${accountName} not found among provisioned batch operators`
        )
        Assert.ok(
          operator.solana,
          `resolveOppBootstrapSeed: epoch-1 group member ${accountName} has no Solana key`
        )
        return operator
      })
    const operators: SolanaOutpostBootstrapper.BootstrapOperator[] = groupOperators.map(operator => ({
        wireName: new anchor.BN(Name.from(operator.account).value.toString()),
        solAddress: new PublicKey(solanaNativePublicKey(operator.solana)),
        role: OperatorType.BATCH,
        status: OperatorStatus.ACTIVE
      })),
      groupMembers = operators.map(operator => operator.solAddress)
    return { operators, groupMembers }
  }
}
