import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import type { OperatorAccount } from "@wireio/cluster-tool/orchestration"
import { ProducerNodeTool } from "@wireio/cluster-tool/tools/wire"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/**
 * A flow-provisioned producer's own nodeop.
 *
 * The planned topology is fixed at config-resolution time, so a producer a flow provisions after
 * bootstrap has no node to run on — this tool is what gives it one, and it is the only path that
 * can prove the collateral-backed onboarding actually reaches block production.
 */
describe("ProducerNodeTool", () => {
  const signal = new AbortController().signal,
    ProducerLabel = "flowprod",
    StartInput = {
      kind: "ProducerNodeTool.StartProducerNodeInput" as const,
      label: ProducerLabel
    },
    StopInput = {
      kind: "ProducerNodeTool.StopProducerNodeInput" as const,
      label: ProducerLabel
    }

  /** A provisioned producer identity: its own K1 and its own finalizer key. */
  function producerAccount(
    label: string,
    type: OperatorType = OperatorType.PRODUCER,
    wireFinalizer: OperatorAccount["wireFinalizer"] = {
      type: KeyType.BLS,
      publicKey: `PUB_BLS_${label}`,
      privateKey: `PVT_BLS_${label}`,
      proofOfPossession: `SIG_BLS_${label}`
    }
  ): OperatorAccount {
    return {
      label,
      publicationLabel: label,
      account: label,
      type,
      wire: {
        type: KeyType.K1,
        publicKey: `PUB_K1_${label}`,
        privateKey: `PVT_K1_${label}`
      },
      ...(wireFinalizer != null ? { wireFinalizer } : {})
    }
  }

  afterEach(() => jest.restoreAllMocks())

  describe("planProducerNodeStart", () => {
    it("carries the label as its typed input so the Report records which producer started", () => {
      const step = ProducerNodeTool.planProducerNodeStart(
        Report.Actor.Producer,
        "start-producer-node",
        "start the flow producer's node",
        {},
        ProducerLabel
      )
      expect(step.input).toEqual(StartInput)
      expect(step.runner).toBe(ProducerNodeTool.runProducerNodeStart)
    })
  })

  describe("runProducerNodeStart", () => {
    it("launches a PRODUCING node for the account, composed by NodeConfig.createAdHoc, through the dirty-chainbase recovery path", async () => {
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      const producer = producerAccount(ProducerLabel)
      ctx.keyStore.setOperator(producer)
      const recoverySpy = jest
        .spyOn(NodeopProcess, "startWithRecovery")
        .mockResolvedValue(undefined)
      await ProducerNodeTool.runProducerNodeStart(ctx, StartInput, signal)
      expect(recoverySpy).toHaveBeenCalledWith(
        ctx.processManager,
        expect.objectContaining({
          operators: [producer],
          node: expect.objectContaining({
            role: NodeRole.producer,
            // It produces for its OWN account and nothing else.
            producers: [producer.account],
            name: NodeConfig.adHocNodeName(producer.label),
            index: NodeConfig.AdHocIndex
          })
        })
      )
      // A flow-provisioned node launches in the BOOTSTRAP form, like every other ad-hoc node.
      expect(recoverySpy.mock.calls[0][1].postBootstrap).toBeUndefined()
    })

    it("peers the node to every planned producer node so it syncs before its first slot", async () => {
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      ctx.keyStore.setOperator(producerAccount(ProducerLabel))
      const recoverySpy = jest
        .spyOn(NodeopProcess, "startWithRecovery")
        .mockResolvedValue(undefined)
      await ProducerNodeTool.runProducerNodeStart(ctx, StartInput, signal)
      const { node } = recoverySpy.mock.calls[0][1]
      expect(node.peerEndpoints).toEqual(
        NodeConfig.producerPeerEndpoints(ctx.config)
      )
      expect(node.peerEndpoints.length).toBeGreaterThan(0)
    })

    it("refuses an operator that is not a producer", async () => {
      // A batch operator has no block-signing role; launching one as a producer would put a
      // --producer-name on the chain for an account the schedule never names.
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      ctx.keyStore.setOperator(producerAccount("batchopzzzz", OperatorType.BATCH))
      await expect(
        ProducerNodeTool.runProducerNodeStart(
          ctx,
          { ...StartInput, label: "batchopzzzz" },
          signal
        )
      ).rejects.toThrow(/not a producer/)
    })

    it("refuses a producer with no finalizer key", async () => {
      // Without one it could sign blocks but never vote — and it would hold no rank position,
      // so the schedule would never name it in the first place.
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      // `null`, not `undefined` — an explicit `undefined` selects the DEFAULT parameter, which
      // would hand the helper a finalizer key and quietly invert this test.
      ctx.keyStore.setOperator(
        producerAccount("keyless", OperatorType.PRODUCER, null)
      )
      await expect(
        ProducerNodeTool.runProducerNodeStart(
          ctx,
          { ...StartInput, label: "keyless" },
          signal
        )
      ).rejects.toThrow(/has no finalizer key/)
    })

    it("is idempotent — a node already under the process manager is not relaunched", async () => {
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      ctx.keyStore.setOperator(producerAccount(ProducerLabel))
      const recoverySpy = jest
        .spyOn(NodeopProcess, "startWithRecovery")
        .mockResolvedValue(undefined)
      jest.spyOn(ctx.processManager, "get").mockReturnValue({} as never)
      await ProducerNodeTool.runProducerNodeStart(ctx, StartInput, signal)
      expect(recoverySpy).not.toHaveBeenCalled()
    })
  })

  describe("planProducerNodeStop", () => {
    it("carries the label as its typed input so the Report records which producer stopped", () => {
      const step = ProducerNodeTool.planProducerNodeStop(
        Report.Actor.Producer,
        "stop-producer-node",
        "stop the flow producer's node",
        {},
        ProducerLabel
      )
      expect(step.input).toEqual(StopInput)
      expect(step.runner).toBe(ProducerNodeTool.runProducerNodeStop)
    })
  })

  describe("runProducerNodeStop", () => {
    it("stops the running node and drops it from the manager, so a later start relaunches it", async () => {
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      const stop = jest.fn().mockResolvedValue(undefined),
        getSpy = jest
          .spyOn(ctx.processManager, "get")
          .mockReturnValue({ stop } as never),
        removeSpy = jest
          .spyOn(ctx.processManager, "remove")
          .mockReturnValue(ctx.processManager)
      await ProducerNodeTool.runProducerNodeStop(ctx, StopInput, signal)
      expect(getSpy).toHaveBeenCalledWith(NodeConfig.adHocNodeName(ProducerLabel))
      expect(stop).toHaveBeenCalledTimes(1)
      expect(removeSpy).toHaveBeenCalledWith(NodeConfig.adHocNodeName(ProducerLabel))
    })

    it("is a no-op when the node is not running — nothing to stop, nothing to remove", async () => {
      const ctx = fixtureContext()
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      jest.spyOn(ctx.processManager, "get").mockReturnValue(undefined)
      const removeSpy = jest.spyOn(ctx.processManager, "remove")
      await expect(
        ProducerNodeTool.runProducerNodeStop(ctx, StopInput, signal)
      ).resolves.toBeUndefined()
      expect(removeSpy).not.toHaveBeenCalled()
    })
  })
})
