import Assert from "node:assert"
import { range } from "lodash"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "../../Constants.js"
import { EthereumWallet } from "../../clients/ethereum/EthereumWallet.js"
import { BatchOperatorSchedule } from "../../config/BatchOperatorSchedule.js"
import { Report } from "../../report/Report.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { OperatorAccount } from "../outputs/OperatorAccount.js"
import { EpochContractSteps } from "../steps/contracts/sysio/EpochContractSteps.js"
import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostBootstrapperOptions,
  type EthereumOutpostInitialRoster
} from "./EthereumOutpostBootstrapper.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { EthereumSyndicationTool } from "../../tools/ethereum/EthereumSyndicationTool.js"
import type { StepInput } from "../StepRunner.js"

/** Steps that deploy + seed the Ethereum (anvil) outpost. */
export namespace EthereumOutpostSteps {
  /** Already-booked local fixture shadow, seeded before subsequent custody funding. */
  export interface DeployInput extends StepInput {
    /** Discriminator for the deployment step's reported input. */
    readonly kind: "EthereumOutpostSteps.DeployInput"
    /** Planned imported shadow obligation in depot units. */
    readonly mockSyndicatedPrincipal: bigint
  }

  /**
   * The PROVISIONAL batch-operator roster the outpost is constructed with
   * (WNE-41: `OPPInbound.initialize` refuses to seat an empty one) — the ETH
   * addresses of every bootstrapped batch operator, grouped in the depot's
   * SHAPE. The depot's real membership is installed later by
   * {@link planOppBootstrap} (`seed-ethereum-roster`), once
   * `sysio.epoch::schbatchgps` has produced it.
   *
   * The addresses are READ off `ctx.keyStore`: the bootstrap materializes every
   * batch operator's identity in Cluster Prerequisites (`OperatorKeys`), ahead
   * of this deploy, precisely so the roster names the random keys the daemons
   * later sign `epochIn` with. Nothing derives an address ahead of its key.
   *
   * Group `k` serves epoch `1 + k` and its length is that epoch's consensus
   * threshold (WNE-27), so the grouping is sized by the depot's own
   * `operators_per_epoch` / `batch_op_groups` from
   * {@link BatchOperatorSchedule.resolve}. Which operator lands in which group
   * is the depot's decision (`sysio.epoch::schbatchgps`), read back by the seed
   * step rather than reproduced here.
   *
   * @param ctx - The build context.
   * @returns The provisional roster for `OPPInbound.initialize`.
   * @throws If a batch operator has not been materialized or has no Ethereum key.
   */
  export function resolveInitialRoster<C extends ClusterBuildContext>(
    ctx: C
  ): EthereumOutpostInitialRoster {
    const { config } = ctx,
      { operatorsPerEpoch, batchOpGroups, batchOperatorMinimumActive } =
        BatchOperatorSchedule.resolve(config),
      // Walk the BATCH-OPERATOR LABEL list in index order: neither the
      // position nor the sort order of an operator in the key store is a
      // contract, the label sequence is.
      addresses = Constants.batchOperatorLabels(config.batchOperatorCount).map(
        label => {
          const operator = ctx.keyStore.assertOperator(label)
          Assert.ok(
            operator.ethereum,
            `resolveInitialRoster: batch operator ${label} has no Ethereum key`
          )
          return operator.ethereum.address
        }
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
   * Partition roster addresses into the SHAPE of the window
   * `sysio.epoch::schbatchgps` builds: TRIM the pool to
   * `batch_operator_minimum_active`, EVEN/ODD INTERLEAVE it, then partition
   * into `batch_op_groups` groups of `operators_per_epoch`.
   *
   * Every group's length is the consensus threshold of the epoch its slot
   * serves (WNE-27), so the sizes must be the depot's. Operators past the
   * scheduled window are left OUT, exactly as the depot leaves them ungrouped:
   * a slot they rode would misrepresent the window and authorize them for an
   * epoch the depot never scheduled them for. Membership within the window is
   * label order here and account-name order on the depot — the seed step
   * ({@link planOppBootstrap}) installs the depot's own before the first
   * envelope.
   *
   * @param addresses - Roster addresses in batch-operator label order.
   * @param operatorsPerEpoch - Depot `operators_per_epoch` (group SIZE).
   * @param batchOpGroups - Depot `batch_op_groups` (group COUNT).
   * @param batchOperatorMinimumActive - Depot `batch_operator_minimum_active`.
   * @returns At most `batchOpGroups` non-empty groups.
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
      ]
    return (
      range(batchOpGroups)
        .map(group =>
          interleaved.slice(
            group * operatorsPerEpoch,
            group * operatorsPerEpoch + operatorsPerEpoch
          )
        )
        // The contract rejects an EMPTY group, so a short pool yields fewer
        // groups rather than padded ones.
        .filter(group => group.length > 0)
    )
  }

  /**
   * Deploy the Ethereum outpost against the already-running run anvil
   * (`Steps.processes.anvil.start`, the deployer and panic wallet steps must
   * precede this in the phase): deploy the `wire-ethereum` contracts as the
   * deployer (later phases re-read `outpost-addrs.json` from disk). Paths and
   * the anvil port come from `ctx.config`; the planned mock shadow obligation
   * is supplied before the one-shot pool initialization.
   */
  export function planDeploy<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    mockSyndicatedPrincipal = 0n
  ): ClusterBuildStep<C, DeployInput> {
    return ClusterBuildStep.create<C, DeployInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumOutpostSteps.DeployInput", mockSyndicatedPrincipal },
      runDeploy
    )
  }

  /**
   * The bootstrapper options every Ethereum-outpost runner constructs from the
   * context — paths, the run anvil's endpoint (same derivation as
   * `AnvilProcess.rpcUrl`: the anvil was bound to this exact port by
   * `Steps.processes.anvil.start`, so they cannot diverge), the persisted
   * deployer and panic wallets, and the roster the call installs.
   */
  function bootstrapperOptions<C extends ClusterBuildContext>(
    ctx: C,
    initialRoster: EthereumOutpostInitialRoster
  ): EthereumOutpostBootstrapperOptions {
    const { dataPath } = ctx.config
    return {
      ethereumPath: ctx.config.ethereumPath,
      rpcUrl: toURL(
        ctx.config.bind.anvil.port,
        toDialAddress(ctx.config.bind.anvil.address)
      ),
      deploymentsPath: ClusterConfigProvider.ethereumDeploymentsPath(
        ctx.config
      ),
      deployer: EthereumWallet.loadKeyPair(
        dataPath,
        EthereumWallet.DeployerWalletName
      ),
      panicAccount: EthereumWallet.loadKeyPair(
        dataPath,
        EthereumWallet.PanicWalletName
      ),
      initialRoster
    }
  }

  /** Named runner — `EthereumOutpostBootstrapper.bootstrap` against the run anvil. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    input: DeployInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await new EthereumOutpostBootstrapper({
      ...bootstrapperOptions(ctx, resolveInitialRoster(ctx)),
      mockSyndicatedPrincipal: input.mockSyndicatedPrincipal
    }).bootstrap()
  }

  /**
   * Seed the Ethereum outpost's batch-operator roster from the depot's REAL
   * schedule via `OPPInbound.installInitialRoster` — the counterpart of
   * `Steps.solanaOutpost.planOppBootstrap` (SOL-376). One write, one step.
   *
   * Runs in `EpochBootstrap` AFTER `schedule-batch-groups` (the schedule must
   * exist to be read) and BEFORE `bootstrap-epoch` (the contract closes the
   * bootstrap window on the first counted epoch-1 delivery). Input-less — the
   * window is read off `sysio.epoch::epochstate` and the operators off
   * `ctx.keyStore` at run time.
   */
  export function planOppBootstrap<
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
      runOppBootstrap
    )
  }

  /** Named runner — `EthereumOutpostBootstrapper.oppBootstrap`. */
  export async function runOppBootstrap<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()

    const epochState = await EpochContractSteps.readEpochState(ctx)
    Assert.ok(
      epochState?.batch_op_groups?.length > 0,
      "runOppBootstrap: the depot has no batch-operator schedule yet — schbatchgps must precede the roster seed"
    )
    const seed = resolveOppBootstrapSeed(
      ctx.keyStore.operatorsByType(OperatorType.BATCH),
      epochState.batch_op_groups,
      epochState.current_batch_op_group,
      ctx.config.epochDurationSec
    )
    await new EthereumOutpostBootstrapper(
      bootstrapperOptions(ctx, seed.window)
    ).oppBootstrap(seed)
  }

  /**
   * Build the `installInitialRoster` seed from the provisioned batch operators
   * and the depot's schedule window: every window group, in slot order, mapped
   * to its members' EVM addresses — the addresses their daemons sign `epochIn`
   * with — plus the slot the depot serves epoch 1 from. Mirrors
   * `SolanaOutpostSteps.resolveOppBootstrapSeed`, minus Solana's single-group
   * packet cap: `installInitialRoster` takes the whole window, so slot `k`
   * serves epoch `1 + k` exactly as a delivered `BATCH_OPERATOR_GROUPS` would.
   *
   * @param batchOperators - every provisioned batch operator (from `ctx.keyStore`).
   * @param window - the depot's `epochstate.batch_op_groups` (account names per slot).
   * @param activeGroupIndex - the depot's `epochstate.current_batch_op_group`.
   * @param epochDurationSec - the depot's epoch duration.
   * @return the seed for {@link EthereumOutpostBootstrapper.oppBootstrap}.
   * @throws if a scheduled account is not among the provisioned batch operators
   *   or its operator lacks an Ethereum key.
   */
  export function resolveOppBootstrapSeed(
    batchOperators: OperatorAccount[],
    window: string[][],
    activeGroupIndex: number,
    epochDurationSec: number
  ): EthereumOutpostBootstrapper.OppBootstrapSeed {
    const operatorByAccount = new Map(
      batchOperators.map(operator => [operator.account, operator])
    )
    return {
      window: {
        groups: window.map(accountNames =>
          accountNames.map(accountName => {
            const operator = operatorByAccount.get(accountName)
            Assert.ok(
              operator,
              `resolveOppBootstrapSeed: scheduled batch operator ${accountName} not found among provisioned batch operators`
            )
            Assert.ok(
              operator.ethereum,
              `resolveOppBootstrapSeed: scheduled batch operator ${accountName} has no Ethereum key`
            )
            // The EM pair carries its address (`KeyPairAddress`) — the same
            // `msg.sender` the operator's daemon signs `epochIn` with.
            return operator.ethereum.address
          })
        ),
        epochDurationSec
      },
      activeGroupIndex
    }
  }

  /**
   * Verify body — the deployed `SyndicationPool` carries the configuration the
   * bootstrapper's deploy config named: the per-transfer maximum and the yield
   * deadband ({@link EthereumOutpostBootstrapper.MaxSyndicationPerTransferWei},
   * {@link EthereumOutpostBootstrapper.YieldDeadbandDepotUnits}), the liq
   * token `LIQETH` at 18 decimals, and the panic account (the persisted
   * {@link EthereumWallet.PanicWalletName} wallet) able to call `pause` and
   * `unpause` on it.
   *
   * @param ctx - The build context.
   * @throws On the first value that differs.
   */
  export async function assertSyndicationPoolConfigured<
    C extends ClusterBuildContext
  >(ctx: C): Promise<void> {
    const configuration =
        await EthereumSyndicationTool.readPoolConfiguration(ctx),
      expected: EthereumSyndicationTool.PoolConfiguration = {
        maxSyndicationPerTransfer: BigInt(
          EthereumOutpostBootstrapper.MaxSyndicationPerTransferWei
        ),
        yieldDeadband: BigInt(
          EthereumOutpostBootstrapper.YieldDeadbandDepotUnits
        ),
        liqTokenCode: EthereumSyndicationTool.liqEthTokenCode(),
        liqTokenPrecision: EthereumSyndicationTool.LiqEthTokenPrecision
      }
    Assert.deepStrictEqual(
      configuration,
      expected,
      "EthereumOutpostSteps: SyndicationPool's configuration is not what the deploy config named"
    )
    const panic = EthereumWallet.loadKeyPair(
        ctx.config.dataPath,
        EthereumWallet.PanicWalletName
      ).address,
      { pause, unpause } = EthereumSyndicationTool.PoolFunction
    await mapSeries([pause, unpause], async functionName =>
      Assert.ok(
        await EthereumSyndicationTool.readCanCallPool(ctx, panic, functionName),
        `EthereumOutpostSteps: the panic account ${panic} may not call SyndicationPool.${functionName}()`
      )
    )
  }
}
