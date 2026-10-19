import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, SysioContracts } from "@wireio/sdk-core"
import {
  AWSAccountName,
  ClusterFiles,
  WireOpregBootstrapSchemaCodec,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import {
  Steps,
  type ClusterBuildContext,
  type OperatorAccount
} from "@wireio/cluster-tool/orchestration"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import { solanaNativePublicKey } from "@wireio/cluster-tool/utils"

import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import {
  fixtureOperatorAccount,
  seedProducerOperators
} from "../outputs/operatorAccountFixture.js"
import { fixtureOperatorRow } from "./contracts/sysio/opregOperatorRowFixture.js"

const { SysioOpregOperatortype, SysioOpregOperatorstatus } = SysioContracts

/** The depot's `epochstate` query result, typed from the client that returns it. */
type EpochStateQueryResult = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getEpochState"]>
>
/** The depot's `epochcfg` query result, typed from the client that returns it. */
type EpochConfigQueryResult = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getEpochConfig"]>
>

/** Bootstrap batch operators: dot-free labels (they seed the K1 placeholder) + 12-char accounts. */
const BatchOperators = [
  { label: "batchopa", account: "wireno.a1b2c", ethereumHdIndex: 1 },
  { label: "batchopb", account: "wireno.d3e4f", ethereumHdIndex: 2 },
  { label: "batchopc", account: "wireno.g5h1i", ethereumHdIndex: 3 }
] as const

/** The window `schbatchgps` builds over {@link BatchOperators} (one per epoch). */
const Window = BatchOperators.map(({ account }) => [account])

/** An AWS placement in the test account — the source of the document's `awsAccount`. */
const TestPlacement: ClusterConfig["awsClusterNodeConfig"] = {
  account: AWSAccountName.test,
  regions: ["us-east-1"],
  ssm: null
}

const signal = new AbortController().signal

/** A provisioned bootstrap batch operator with REAL EM + ED keys. */
function batchOperator(index: number): OperatorAccount {
  const { label, account, ethereumHdIndex } = BatchOperators[index]
  return fixtureOperatorAccount(label, OperatorType.BATCH, account, ethereumHdIndex)
}

/** The `epochstate` row right after `schbatchgps`. */
function epochStateRow(): SysioContracts.SysioEpochEpochStateType {
  return {
    current_epoch_index: 0,
    current_epoch_start: "2026-10-16T00:00:00.000",
    next_epoch_start: "2026-10-16T00:01:00.000",
    current_batch_op_group: 0,
    batch_op_groups: Window,
    last_consensus_hash: "",
    is_paused: false
  }
}

/** The `epochcfg` row carrying the cluster's epoch duration. */
function epochConfigRow(
  epochDurationSec: number
): SysioContracts.SysioEpochEpochConfigType {
  return {
    epoch_duration_sec: epochDurationSec,
    operators_per_epoch: 1,
    batch_operator_minimum_active: BatchOperators.length,
    batch_op_groups: BatchOperators.length,
    epoch_retention_envelope_log_count: 10
  }
}

/** Serve the epoch reads from stubbed rows (an absent row = an empty table). */
function serveEpoch(
  ctx: ClusterBuildContext,
  epochState: SysioContracts.SysioEpochEpochStateType,
  epochConfig: SysioContracts.SysioEpochEpochConfigType
): void {
  jest
    .spyOn(ctx.wire, "getEpochState")
    .mockResolvedValue({ rows: epochState == null ? [] : [epochState] } as EpochStateQueryResult)
  jest
    .spyOn(ctx.wire, "getEpochConfig")
    .mockResolvedValue({ rows: epochConfig == null ? [] : [epochConfig] } as EpochConfigQueryResult)
}

/** Serve `rows` from the context's `sysio.opreg::operators` table. */
function serveOperators(
  ctx: ClusterBuildContext,
  rows: SysioContracts.SysioOpregOperatorEntryType[]
): void {
  const contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
  jest.spyOn(contract.tables.operators, "query").mockResolvedValue({ rows, more: false })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
}

describe("Steps.wireOpregBootstrap", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-opreg-bootstrap-steps-"))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A context over the temp cluster dir, seeded with the genesis identities,
   * producers and batch operators.
   *
   * @param awsClusterNodeConfig - The cluster's AWS placement (default: none).
   */
  function seededContext(
    awsClusterNodeConfig: ClusterConfig["awsClusterNodeConfig"] = null
  ): ClusterBuildContext {
    const ctx = fixtureContext({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      awsClusterNodeConfig
    })
    ctx.keyStore.setOperator(fixtureOperatorAccount("bios", OperatorType.UNKNOWN, "sysio"))
    seedProducerOperators(ctx)
    BatchOperators.forEach((_operator, index) => ctx.keyStore.setOperator(batchOperator(index)))
    return ctx
  }

  /** The depot's opreg rows matching {@link seededContext}'s bootstrapped operators. */
  function depotRows(ctx: ClusterBuildContext): SysioContracts.SysioOpregOperatorEntryType[] {
    return [
      ...ctx.keyStore
        .operatorsByType(OperatorType.PRODUCER)
        .map(operator => fixtureOperatorRow(operator.account, SysioOpregOperatortype.OPERATOR_TYPE_PRODUCER)),
      ...BatchOperators.map(({ account }) =>
        fixtureOperatorRow(account, SysioOpregOperatortype.OPERATOR_TYPE_BATCH)
      )
    ]
  }

  it("filePath names wire-opreg-bootstrap.json under the cluster directory", () => {
    expect(Steps.wireOpregBootstrap.filePath(dir)).toBe(
      Path.join(dir, ClusterFiles.WireOpregBootstrapFilename)
    )
  })

  it.each(["planEmit", "planVerify"] as const)("%s builds an input-less step with a runner", factory => {
    const step = Steps.wireOpregBootstrap[factory](Report.Actor.Sysio, factory, factory, {})
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  describe("toWireOpregBootstrapOperator", () => {
    it("maps a batch operator to wire + ethereum + solana slots with their addresses", () => {
      const operator = batchOperator(0),
        entry = Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(operator)
      expect(entry).toEqual({
        accountName: BatchOperators[0].account,
        type: OperatorType.BATCH,
        keys: {
          wire: { type: KeyType.K1, publicKey: operator.wire.publicKey },
          ethereum: {
            type: KeyType.EM,
            publicKey: operator.ethereum.publicKey,
            address: operator.ethereum.address
          },
          solana: {
            type: KeyType.ED,
            publicKey: operator.solana.publicKey,
            address: solanaNativePublicKey(operator.solana)
          }
        }
      })
    })

    it("maps a producer to wire + wireFinalizer (with its proof of possession) and carries no key material", () => {
      const [producer] = seedProducerOperators(fixtureContext()),
        entry = Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(producer)
      expect(entry.keys).toEqual({
        wire: { type: KeyType.K1, publicKey: producer.wire.publicKey },
        wireFinalizer: {
          type: KeyType.BLS,
          publicKey: producer.wireFinalizer.publicKey,
          proofOfPossession: producer.wireFinalizer.proofOfPossession
        }
      })
      expect(JSON.stringify(entry)).not.toContain("PVT_")
    })

    it("throws for an operator with no on-chain account yet", () => {
      const operator = { ...batchOperator(0), account: undefined }
      expect(() => Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(operator)).toThrow(
        /batchopa.*no on-chain account/
      )
    })

    it("throws for a producer without its WIRE finality key", () => {
      const [producer] = seedProducerOperators(fixtureContext()),
        operator = { ...producer, wireFinalizer: undefined }
      expect(() => Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(operator)).toThrow(
        /has no WIRE finality key/
      )
    })

    it("throws for a batch operator without its Ethereum or Solana key", () => {
      const operator = { ...batchOperator(0), solana: undefined }
      expect(() => Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(operator)).toThrow(
        /lacks its Ethereum or Solana key/
      )
    })

    it("throws for an operator type no roster entry admits", () => {
      const operator = fixtureOperatorAccount("bios", OperatorType.UNKNOWN, "sysio")
      expect(() => Steps.wireOpregBootstrap.toWireOpregBootstrapOperator(operator)).toThrow(
        /is UNKNOWN, which a roster entry does not admit/
      )
    })
  })

  describe("resolveWireOpregBootstrap", () => {
    it("rosters every PRODUCER / BATCH operator, excluding the UNKNOWN genesis identities", () => {
      const ctx = seededContext(),
        bootstrap = Steps.wireOpregBootstrap.resolveWireOpregBootstrap(
          ctx.keyStore.operators,
          epochStateRow(),
          epochConfigRow(ctx.config.epochDurationSec),
          ctx.config.awsClusterNodeConfig
        )
      expect(bootstrap.operators.map(operator => operator.accountName)).not.toContain("sysio")
      expect(bootstrap.operators).toHaveLength(ctx.config.producerCount + BatchOperators.length)
    })

    it("orders the roster by operator type, then account name", () => {
      const ctx = seededContext(),
        { operators } = Steps.wireOpregBootstrap.resolveWireOpregBootstrap(
          [...ctx.keyStore.operators].reverse(),
          epochStateRow(),
          epochConfigRow(ctx.config.epochDurationSec),
          ctx.config.awsClusterNodeConfig
        ),
        producers = operators.filter(operator => operator.type === OperatorType.PRODUCER),
        batch = operators.filter(operator => operator.type === OperatorType.BATCH)
      expect(operators).toEqual([...producers, ...batch])
      expect(producers.map(operator => operator.accountName)).toEqual(
        producers.map(operator => operator.accountName).sort((left, right) => left.localeCompare(right))
      )
      expect(batch.map(operator => operator.accountName)).toEqual(
        BatchOperators.map(({ account }) => account)
      )
    })

    it("takes the schedule from epochstate and the epoch duration from epochcfg", () => {
      const ctx = seededContext(),
        epochState = { ...epochStateRow(), current_batch_op_group: 2 },
        bootstrap = Steps.wireOpregBootstrap.resolveWireOpregBootstrap(
          ctx.keyStore.operators,
          epochState,
          epochConfigRow(90),
          ctx.config.awsClusterNodeConfig
        )
      expect(bootstrap.epochDurationSec).toBe(90)
      expect(bootstrap.batchOperatorGroups).toEqual({ activeGroupIndex: 2, groups: Window })
    })

    it("takes the AWS account from the cluster's placement and leaves the label null", () => {
      const ctx = seededContext(TestPlacement),
        bootstrap = Steps.wireOpregBootstrap.resolveWireOpregBootstrap(
          ctx.keyStore.operators,
          epochStateRow(),
          epochConfigRow(ctx.config.epochDurationSec),
          ctx.config.awsClusterNodeConfig
        )
      expect(bootstrap.awsAccount).toBe(AWSAccountName.test)
      expect(bootstrap.label).toBeNull()
    })

    it("writes a null AWS account when the cluster has no AWS placement", () => {
      const ctx = seededContext(),
        bootstrap = Steps.wireOpregBootstrap.resolveWireOpregBootstrap(
          ctx.keyStore.operators,
          epochStateRow(),
          epochConfigRow(ctx.config.epochDurationSec),
          ctx.config.awsClusterNodeConfig
        )
      expect(bootstrap.awsAccount).toBeNull()
    })
  })

  describe("runEmit", () => {
    it("writes a codec-valid wire-opreg-bootstrap.json into the cluster directory", async () => {
      const ctx = seededContext()
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec))

      await Steps.wireOpregBootstrap.runEmit(ctx, null, signal)

      const file = Steps.wireOpregBootstrap.filePath(dir),
        bootstrap = WireOpregBootstrapSchemaCodec.deserialize(Fs.readFileSync(file))
      expect(bootstrap.epochDurationSec).toBe(ctx.config.epochDurationSec)
      expect(bootstrap.batchOperatorGroups).toEqual({ activeGroupIndex: 0, groups: Window })
      expect(bootstrap.operators.filter(operator => operator.type === OperatorType.BATCH)).toHaveLength(
        BatchOperators.length
      )
      expect(Fs.readFileSync(file, "utf-8")).not.toMatch(/PVT_/)
    })

    it("writes the label and AWS account keys as explicit nulls when there is no placement", async () => {
      const ctx = seededContext()
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec))

      await Steps.wireOpregBootstrap.runEmit(ctx, null, signal)

      const json = JSON.parse(Fs.readFileSync(Steps.wireOpregBootstrap.filePath(dir), "utf-8"))
      expect(json).toHaveProperty("label", null)
      expect(json).toHaveProperty("awsAccount", null)
    })

    it("writes the AWS account of the cluster's placement", async () => {
      const ctx = seededContext(TestPlacement)
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec))

      await Steps.wireOpregBootstrap.runEmit(ctx, null, signal)

      const bootstrap = WireOpregBootstrapSchemaCodec.deserialize(
        Fs.readFileSync(Steps.wireOpregBootstrap.filePath(dir))
      )
      expect(bootstrap.awsAccount).toBe(AWSAccountName.test)
      expect(bootstrap.label).toBeNull()
    })

    it("records the written document as the step's Report artifact", async () => {
      const ctx = seededContext(),
        recorder = new StepExtraRecorder()
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec))

      await StepExtraRecorder.runWith(recorder, () =>
        Steps.wireOpregBootstrap.runEmit(ctx, null, signal)
      )

      const written = JSON.parse(Fs.readFileSync(Steps.wireOpregBootstrap.filePath(dir), "utf-8"))
      expect(recorder.calls).toContainEqual({
        client: "harness",
        kind: "artifact",
        file: ClusterFiles.WireOpregBootstrapFilename,
        contents: written
      })
    })

    it("throws when the depot has no batch-operator schedule yet", async () => {
      const ctx = seededContext()
      serveEpoch(ctx, { ...epochStateRow(), batch_op_groups: [] }, epochConfigRow(60))
      await expect(Steps.wireOpregBootstrap.runEmit(ctx, null, signal)).rejects.toThrow(
        /schbatchgps must precede it/
      )
    })

    it("throws when sysio.epoch::epochcfg has no row", async () => {
      const ctx = seededContext()
      serveEpoch(ctx, epochStateRow(), null)
      await expect(Steps.wireOpregBootstrap.runEmit(ctx, null, signal)).rejects.toThrow(
        /epochcfg has no row/
      )
    })

    it("short-circuits on an already-aborted signal — no file is written", async () => {
      const ctx = seededContext(),
        controller = new AbortController()
      controller.abort()
      await expect(Steps.wireOpregBootstrap.runEmit(ctx, null, controller.signal)).rejects.toThrow()
      expect(Fs.existsSync(Steps.wireOpregBootstrap.filePath(dir))).toBe(false)
    })
  })

  describe("runVerify", () => {
    /**
     * Emit the file, then serve `rows` as the depot's opreg table.
     *
     * @param rows - The depot's opreg rows for the emitted context.
     * @param awsClusterNodeConfig - The cluster's AWS placement (default: none).
     */
    async function emitted(
      rows: (ctx: ClusterBuildContext) => SysioContracts.SysioOpregOperatorEntryType[],
      awsClusterNodeConfig: ClusterConfig["awsClusterNodeConfig"] = null
    ): Promise<ClusterBuildContext> {
      const ctx = seededContext(awsClusterNodeConfig)
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec))
      await Steps.wireOpregBootstrap.runEmit(ctx, null, signal)
      serveOperators(ctx, rows(ctx))
      return ctx
    }

    it("passes when the roster is exactly the depot's bootstrapped, ACTIVE operators", async () => {
      const ctx = await emitted(context => [
        ...depotRows(context),
        // Not bootstrapped / not a roster type — both outside the roster.
        fixtureOperatorRow("wireno.z1z2z", SysioOpregOperatortype.OPERATOR_TYPE_BATCH, {
          is_bootstrapped: false
        }),
        fixtureOperatorRow("sysio", SysioOpregOperatortype.OPERATOR_TYPE_UNKNOWN)
      ])
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).resolves.toBeUndefined()
    })

    it("fails when a bootstrapped depot operator is missing from the roster", async () => {
      const ctx = await emitted(context => [
        ...depotRows(context),
        fixtureOperatorRow("wireno.z1z2z", SysioOpregOperatortype.OPERATOR_TYPE_BATCH)
      ])
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        /not the depot's set of bootstrapped operators/
      )
    })

    it("fails when a roster operator is not a bootstrapped depot operator", async () => {
      const ctx = await emitted(context =>
        depotRows(context).map(row =>
          row.account === BatchOperators[0].account ? { ...row, is_bootstrapped: false } : row
        )
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        /not the depot's set of bootstrapped operators/
      )
    })

    it("fails when a roster operator's depot type differs", async () => {
      const ctx = await emitted(context =>
        depotRows(context).map(row =>
          row.account === BatchOperators[0].account
            ? { ...row, type: SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER }
            : row
        )
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        new RegExp(`${BatchOperators[0].account} is BATCH in the file`)
      )
    })

    it("fails when a roster operator is not ACTIVE on the depot", async () => {
      const ctx = await emitted(context =>
        depotRows(context).map(row =>
          row.account === BatchOperators[1].account
            ? { ...row, status: SysioOpregOperatorstatus.OPERATOR_STATUS_WARMUP }
            : row
        )
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        new RegExp(`${BatchOperators[1].account} is not ACTIVE`)
      )
    })

    it("accepts the depot's enum cells in their proto spelling", async () => {
      const ctx = await emitted(context =>
        depotRows(context).map(row => ({
          ...row,
          type: SysioOpregOperatortype[row.type as SysioContracts.SysioOpregOperatortype] as keyof typeof SysioOpregOperatortype,
          status: "OPERATOR_STATUS_ACTIVE" as keyof typeof SysioOpregOperatorstatus
        }))
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).resolves.toBeUndefined()
    })

    it("fails when the file's epoch duration is not the cluster's", async () => {
      const ctx = seededContext()
      serveEpoch(ctx, epochStateRow(), epochConfigRow(ctx.config.epochDurationSec + 1))
      await Steps.wireOpregBootstrap.runEmit(ctx, null, signal)
      serveOperators(ctx, depotRows(ctx))
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        /epoch duration is not the cluster's/
      )
    })

    it("passes for a cluster with an AWS placement", async () => {
      const ctx = await emitted(depotRows, TestPlacement)
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).resolves.toBeUndefined()
    })

    it("fails when the file's AWS account is not the cluster's", async () => {
      const ctx = await emitted(depotRows, TestPlacement),
        file = Steps.wireOpregBootstrap.filePath(dir),
        bootstrap = WireOpregBootstrapSchemaCodec.deserialize(Fs.readFileSync(file))
      Fs.writeFileSync(
        file,
        WireOpregBootstrapSchemaCodec.serialize({ ...bootstrap, awsAccount: AWSAccountName.prod })
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        /AWS account is not the cluster's/
      )
    })

    it("does not compare the label — the workflow sets it after the bootstrap", async () => {
      const ctx = await emitted(depotRows),
        file = Steps.wireOpregBootstrap.filePath(dir),
        bootstrap = WireOpregBootstrapSchemaCodec.deserialize(Fs.readFileSync(file))
      Fs.writeFileSync(
        file,
        WireOpregBootstrapSchemaCodec.serialize({ ...bootstrap, label: "testnet-epoch60" })
      )
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).resolves.toBeUndefined()
    })

    it("fails when the file's schedule is not the depot's epochstate window", async () => {
      const ctx = await emitted(depotRows)
      jest.spyOn(ctx.wire, "getEpochState").mockResolvedValue({
        rows: [{ ...epochStateRow(), batch_op_groups: [...Window].reverse() }]
      } as EpochStateQueryResult)
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(
        /schedule is not the depot's epochstate window/
      )
    })

    it("fails when the file was never emitted", async () => {
      const ctx = seededContext()
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, signal)).rejects.toThrow(/was not emitted/)
    })

    it("short-circuits on an already-aborted signal — the depot is never read", async () => {
      const ctx = await emitted(depotRows),
        operatorsRead = jest.spyOn(Steps.contracts.sysio.opreg, "readOperators"),
        controller = new AbortController()
      controller.abort()
      await expect(Steps.wireOpregBootstrap.runVerify(ctx, controller.signal)).rejects.toThrow()
      expect(operatorsRead).not.toHaveBeenCalled()
    })
  })
})
