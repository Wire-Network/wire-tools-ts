import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterFiles,
  mapOutpostChains,
  OutpostChainCodenames,
  WireOpregBootstrap,
  WireOpregBootstrapSchemaCodec,
  type ClusterConfig,
  type PerOutpostChain,
  type WireOpregBootstrapOperator,
  type WireOpregBootstrapOppOperatorKeys,
  type WireOpregBootstrapProducerKeys
} from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { abiEnumValue } from "../../utils/enumUtils.js"
import { solanaNativePublicKey } from "../../utils/keyPairUtils.js"
import { matchesProtoEnum } from "../../utils/predicateUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { OperatorAccount } from "../outputs/OperatorAccount.js"
import { verifyStep } from "../StepTools.js"
import { EpochContractSteps } from "./contracts/sysio/EpochContractSteps.js"
import { OpregContractSteps } from "./contracts/sysio/OpregContractSteps.js"

const log = getLogger(__filename)
const { SysioOpregOperatortype, SysioOpregOperatorstatus } = SysioContracts

/**
 * Steps that emit and verify `wire-opreg-bootstrap.json`
 * (`ClusterFiles.WireOpregBootstrapFilename`) in the cluster directory: the
 * bootstrapped operator roster (WIRE account, operator type, public keys) and,
 * for each outpost chain, its consensus epoch duration and the initial
 * batch-operator schedule its `sysio.epoch::schbatchgps` built. Composed into
 * `EpochBootstrap` right after the chains' `schedule-batch-groups-<chain>`
 * steps, in every cluster mode.
 */
export namespace WireOpregBootstrapSteps {
  /** One outpost chain's depot rows the document is resolved from. */
  export interface ChainEpochRows {
    /** The chain's `sysio.epoch::epochstate` row — its schedule window and cursor. */
    readonly epochState: SysioContracts.SysioEpochEpochStateType
    /** The chain's `sysio.epoch::epochcfg` row — its consensus epoch duration. */
    readonly epochConfig: SysioContracts.SysioEpochEpochConfigType
  }

  /**
   * `wire-opreg-bootstrap.json` under a cluster directory.
   *
   * @param clusterPath - The cluster directory.
   * @returns The file's absolute path.
   */
  export function filePath(clusterPath: ClusterConfig["clusterPath"]): string {
    return Path.join(clusterPath, ClusterFiles.WireOpregBootstrapFilename)
  }

  /**
   * Emit `wire-opreg-bootstrap.json`. Input-less — the roster comes from
   * `ctx.keyStore`, each chain's schedule and epoch duration from the depot, the AWS
   * account from the cluster config; the label is written `null` (the
   * `create-wire-platform-cluster` workflow sets it after a successful create).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The emit step (runner: {@link runEmit}).
   */
  export function planEmit<
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
      runEmit
    )
  }

  /**
   * Every outpost chain's `epochstate` and `epochcfg` rows — a read: one of each table.
   *
   * @param ctx - The build context.
   * @returns Each chain's rows.
   * @throws When a chain has no batch-operator schedule or no epoch config yet.
   */
  export async function readChainEpochRows<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<ChainEpochRows>> {
    const [epochStates, epochConfigs] = await Promise.all([
      EpochContractSteps.readEpochStates(ctx),
      EpochContractSteps.readEpochConfigs(ctx)
    ])
    return mapOutpostChains(chain => {
      const epochState = epochStates[chain],
        epochConfig = epochConfigs[chain]
      Assert.ok(
        epochState?.batch_op_groups?.length > 0,
        `WireOpregBootstrapSteps: the depot has no ${chain} batch-operator schedule yet — its schbatchgps must precede it`
      )
      Assert.ok(
        epochConfig != null,
        `WireOpregBootstrapSteps: sysio.epoch::epochcfg has no ${chain} row — its setconfig must precede it`
      )
      return { epochState, epochConfig }
    })
  }

  /**
   * Named runner for {@link planEmit} — read every chain's `sysio.epoch::epochstate` and
   * `epochcfg` rows, resolve the document, write it through its codec, and record it as the
   * step's artifact.
   *
   * @param ctx - The build context.
   * @param _input - Unused (the step is input-less).
   * @param signal - The step's abort signal.
   * @throws When a chain has no batch-operator schedule or no epoch config yet.
   */
  export async function runEmit<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const bootstrap = resolveWireOpregBootstrap(
        ctx.keyStore.operators,
        await readChainEpochRows(ctx),
        ctx.config.awsClusterNodeConfig
      ),
      text = WireOpregBootstrapSchemaCodec.serialize(bootstrap),
      file = filePath(ctx.config.clusterPath)
    Fs.writeFileSync(file, text)
    StepExtraRecorder.record({
      client: "harness",
      kind: "artifact",
      file: ClusterFiles.WireOpregBootstrapFilename,
      contents: JSON.parse(text) as Record<string, unknown>
    })
    log.info(
      `[wire-opreg-bootstrap] wrote ${file}: ${bootstrap.operators.length} operator(s); ` +
        OutpostChainCodenames.map(chain => {
          const { epochDurationSec, batchOperatorGroups } = bootstrap.chains[chain]
          return (
            `${chain} ${epochDurationSec}s epochs, ${batchOperatorGroups.groups.length} ` +
            `batch-operator group(s), active group ${batchOperatorGroups.activeGroupIndex}`
          )
        }).join("; ")
    )
  }

  /**
   * Verify the emitted file against the depot. Input-less.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step (body: {@link runVerify}).
   */
  export function planVerify<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(actor, name, description, runVerify, options)
  }

  /**
   * Verify body for {@link planVerify} — decode the file from disk, then assert
   * that its roster is exactly the depot's bootstrapped PRODUCER / BATCH /
   * UNDERWRITER `sysio.opreg::operators` rows (read through
   * `OpregContractSteps.readOperators`), each with the file's operator type and
   * ACTIVE status; that each chain's schedule is that chain's `epochstate`
   * window and cursor; that each chain's epoch duration is its `epochcfg`
   * duration and the cluster's; and that its AWS account is the cluster's.
   * Operator types bridge to the ABI enum by VALUE (`abiEnumValue`).
   *
   * @param ctx - The build context.
   * @param signal - The step's abort signal.
   * @throws On the first disagreement.
   */
  export async function runVerify<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const file = filePath(ctx.config.clusterPath)
    Assert.ok(
      Fs.existsSync(file),
      `WireOpregBootstrapSteps.runVerify: ${file} was not emitted`
    )
    const bootstrap = WireOpregBootstrapSchemaCodec.deserialize(
        Fs.readFileSync(file)
      ),
      bootstrappedRows = (await OpregContractSteps.readOperators(ctx)).filter(
        row => row.is_bootstrapped && isRosterType(row.type)
      ),
      rowByAccount = new Map(bootstrappedRows.map(row => [row.account, row]))
    Assert.deepStrictEqual(
      sortedAccounts(bootstrap.operators.map(operator => operator.accountName)),
      sortedAccounts(bootstrappedRows.map(row => row.account)),
      "WireOpregBootstrapSteps.runVerify: the roster is not the depot's set of bootstrapped operators"
    )
    bootstrap.operators.forEach(operator => {
      const row = rowByAccount.get(operator.accountName)
      Assert.ok(
        matchesProtoEnum(
          row.type,
          SysioOpregOperatortype,
          abiEnumValue(SysioOpregOperatortype, operator.type)
        ),
        `WireOpregBootstrapSteps.runVerify: ${operator.accountName} is ${OperatorType[operator.type]} ` +
          `in the file but ${row.type} on sysio.opreg`
      )
      Assert.ok(
        matchesProtoEnum(
          row.status,
          SysioOpregOperatorstatus,
          SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
        ),
        `WireOpregBootstrapSteps.runVerify: ${operator.accountName} is not ACTIVE on sysio.opreg (status ${row.status})`
      )
    })
    const chainRows = await readChainEpochRows(ctx)
    OutpostChainCodenames.forEach(chain => {
      const { epochState, epochConfig } = chainRows[chain],
        { batchOperatorGroups, epochDurationSec } = bootstrap.chains[chain]
      Assert.deepStrictEqual(
        batchOperatorGroups,
        {
          activeGroupIndex: epochState.current_batch_op_group,
          groups: epochState.batch_op_groups
        },
        `WireOpregBootstrapSteps.runVerify: the ${chain} batch-operator schedule is not its epochstate window`
      )
      Assert.strictEqual(
        epochDurationSec,
        epochConfig.epoch_duration_sec,
        `WireOpregBootstrapSteps.runVerify: the file's ${chain} epoch duration is not its epochcfg duration`
      )
      Assert.strictEqual(
        epochDurationSec,
        ctx.config.outpostEpochDurationSec[chain],
        `WireOpregBootstrapSteps.runVerify: the file's ${chain} epoch duration is not the cluster's`
      )
    })
    Assert.strictEqual(
      bootstrap.awsAccount,
      toAWSAccount(ctx.config.awsClusterNodeConfig),
      "WireOpregBootstrapSteps.runVerify: the file's AWS account is not the cluster's"
    )
  }

  /**
   * The document — pure. The roster is every key-store operator of a
   * `WireOpregBootstrap.OperatorTypes` type (the genesis identities are
   * `UNKNOWN`-typed and fall out), ordered by operator type then account name;
   * each chain's schedule and epoch duration are its depot rows'; the AWS account
   * is the cluster's placement account. The label is `null` — the cluster-tool
   * does not know it; the `create-wire-platform-cluster` workflow sets it after a
   * successful create.
   *
   * @param operators - Every provisioned operator (`ctx.keyStore.operators`).
   * @param chainRows - Each outpost chain's `epochstate` and `epochcfg` rows.
   * @param awsClusterNodeConfig - The cluster's AWS placement, or `null`.
   * @returns The `wire-opreg-bootstrap.json` document.
   */
  export function resolveWireOpregBootstrap(
    operators: ReadonlyArray<OperatorAccount>,
    chainRows: PerOutpostChain<ChainEpochRows>,
    awsClusterNodeConfig: ClusterConfig["awsClusterNodeConfig"]
  ): WireOpregBootstrap {
    return {
      label: null,
      awsAccount: toAWSAccount(awsClusterNodeConfig),
      operators: operators
        .filter(operator =>
          WireOpregBootstrap.OperatorTypes.includes(operator.type)
        )
        .map(toWireOpregBootstrapOperator)
        .sort(compareRosterOrder),
      chains: mapOutpostChains(chain => ({
        epochDurationSec: chainRows[chain].epochConfig.epoch_duration_sec,
        batchOperatorGroups: {
          activeGroupIndex: chainRows[chain].epochState.current_batch_op_group,
          groups: chainRows[chain].epochState.batch_op_groups
        }
      }))
    }
  }

  /**
   * One provisioned operator's public roster entry — pure. The entry's `type`
   * fixes its key slots: a PRODUCER carries `wire` + `wireFinalizer` (with its
   * proof of possession), a BATCH operator or UNDERWRITER carries `wire` +
   * `ethereum` (with its EVM address) + `solana` (with its base58 address). Each
   * slot keeps the key's curve and public key; no key material is carried.
   *
   * @param operator - The provisioned operator.
   * @returns The operator's roster entry.
   * @throws When the operator has no on-chain account yet, lacks a key its type
   *   requires, or has a type no roster entry admits.
   */
  export function toWireOpregBootstrapOperator(
    operator: OperatorAccount
  ): WireOpregBootstrapOperator {
    const { label, account: accountName, type } = operator
    Assert.ok(
      accountName,
      `WireOpregBootstrapSteps: operator "${label}" has no on-chain account yet`
    )
    return match(type)
      .with(OperatorType.PRODUCER, producerType => ({
        accountName,
        type: producerType,
        keys: toProducerKeys(operator)
      }))
      .with(OperatorType.BATCH, OperatorType.UNDERWRITER, oppOperatorType => ({
        accountName,
        type: oppOperatorType,
        keys: toOppOperatorKeys(operator)
      }))
      .otherwise(() => {
        throw new Error(
          `WireOpregBootstrapSteps: operator "${label}" is ${OperatorType[type]}, which a roster entry does not admit`
        )
      })
  }

  /** A producer's public keys — its WIRE account key and WIRE finality key. */
  function toProducerKeys(
    operator: OperatorAccount
  ): WireOpregBootstrapProducerKeys {
    const { label, wire, wireFinalizer } = operator
    Assert.ok(
      wireFinalizer,
      `WireOpregBootstrapSteps: producer "${label}" has no WIRE finality key`
    )
    return {
      wire: { type: wire.type, publicKey: wire.publicKey },
      wireFinalizer: {
        type: wireFinalizer.type,
        publicKey: wireFinalizer.publicKey,
        proofOfPossession: wireFinalizer.proofOfPossession
      }
    }
  }

  /** A batch operator's or underwriter's public keys — its WIRE account key and its Ethereum + Solana keys. */
  function toOppOperatorKeys(
    operator: OperatorAccount
  ): WireOpregBootstrapOppOperatorKeys {
    const { label, wire, ethereum, solana } = operator
    Assert.ok(
      ethereum && solana,
      `WireOpregBootstrapSteps: operator "${label}" lacks its Ethereum or Solana key`
    )
    return {
      wire: { type: wire.type, publicKey: wire.publicKey },
      ethereum: {
        type: ethereum.type,
        publicKey: ethereum.publicKey,
        address: ethereum.address
      },
      solana: {
        type: solana.type,
        publicKey: solana.publicKey,
        address: solanaNativePublicKey(solana)
      }
    }
  }

  /**
   * The document's `awsAccount` — the placement's account, or an explicit
   * `null` (not `undefined`) so the key survives JSON persistence.
   */
  function toAWSAccount(
    awsClusterNodeConfig: ClusterConfig["awsClusterNodeConfig"]
  ): WireOpregBootstrap["awsAccount"] {
    return awsClusterNodeConfig?.account ?? null
  }

  /** Whether a `sysio.opreg::operators` type cell names a roster operator type. */
  function isRosterType(
    cell: SysioContracts.SysioOpregOperatorEntryType["type"]
  ): boolean {
    return WireOpregBootstrap.OperatorTypes.some(type =>
      matchesProtoEnum(
        cell,
        SysioOpregOperatortype,
        abiEnumValue(SysioOpregOperatortype, type)
      )
    )
  }

  /** Roster order — `WireOpregBootstrap.OperatorTypes` order, then account name. */
  function compareRosterOrder(
    left: WireOpregBootstrapOperator,
    right: WireOpregBootstrapOperator
  ): number {
    const { OperatorTypes } = WireOpregBootstrap
    return (
      OperatorTypes.indexOf(left.type) - OperatorTypes.indexOf(right.type) ||
      left.accountName.localeCompare(right.accountName)
    )
  }

  /** Account names in a stable order, for set comparison. */
  function sortedAccounts(accounts: string[]): string[] {
    return [...accounts].sort((left, right) => left.localeCompare(right))
  }
}
