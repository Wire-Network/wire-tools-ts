import { ethers } from "ethers"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import {
  OperatorDaemonArtifactsKey,
  type OperatorAccount,
  type OperatorDaemonArtifacts
} from "@wireio/cluster-tool/orchestration/outputs"
import { Report } from "@wireio/cluster-tool/report"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic = "test test test test test test test test test test test junk"

/**
 * A fully-keyed OperatorAccount fixture for the given account/type — REAL
 * (decodable) ethereum + solana keys, since `resolveOperatorDaemonArgs`
 * threads them through `KeyGenerator.toSignatureProvider`.
 */
function operatorAccount(account: string, type: OperatorType): OperatorAccount {
  const wallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(AnvilMnemonic),
      "m/44'/60'/0'/0/1"
    ),
    edPrivate = PrivateKey.generate(KeyType.ED)
  return {
    label: account,
    account,
    type,
    wire: { type: KeyType.K1, publicKey: `PUB_K1_${account}`, privateKey: `PVT_K1_${account}` },
    ethereum: ethereumKeyPairFromWallet(wallet),
    solana: {
      type: KeyType.ED,
      publicKey: edPrivate.toPublic().toString(),
      privateKey: edPrivate.toString()
    }
  }
}

/** Fixture {@link OperatorDaemonArtifacts} — shape only, content is unchecked here. */
const artifactsFixture: OperatorDaemonArtifacts = {
  ethereumAbiFiles: ["/cluster/data/eth-abis/OPP.json"],
  ethereumAddresses: {
    OPP: "0x1111111111111111111111111111111111111111",
    OPPInbound: "0x2222222222222222222222222222222222222222",
    OperatorRegistry: "0x3333333333333333333333333333333333333333",
    ReserveManager: "0x4444444444444444444444444444444444444444"
  },
  solanaProgramId: "GrqvbZLCLkfeSQqvE7rL8XKHVWjNhAG2faLsY8yr9tD5",
  solanaIdlFile: "/cluster/data/solana-idls/liqsol_core.json"
}

/** A planned node over `ctx.config` — mirrors the local helper in `NodeopProcess.test.ts`. */
function testNode(
  ctx: ReturnType<typeof fixtureContext>,
  role: NodeRole,
  index: number,
  name: string,
  producers: string[] = [],
  batchOperatorLabel: string | null = null,
  underwriterLabel: string | null = null
): NodeConfig {
  return new NodeConfig(
    ctx.config,
    role,
    index,
    name,
    { http: 8_000 + index, p2p: 9_000 + index },
    producers,
    [],
    batchOperatorLabel,
    underwriterLabel
  )
}

describe("Steps.processes.nodeop", () => {
  it("start carries the target node name as typed input", () => {
    const step = Steps.processes.nodeop.planStart(
      Report.Actor.Producer,
      "start-node_00",
      "start node_00",
      {},
      "node_00"
    )
    expect(step.actor).toBe(Report.Actor.Producer)
    expect(step.input.kind).toBe("NodeopProcessSteps.StartInput")
    expect(step.input.nodeName).toBe("node_00")
    expect(typeof step.runner).toBe("function")
  })

  it("restart carries the target node name as typed input", () => {
    const step = Steps.processes.nodeop.planRestart(
      Report.Actor.Underwriter,
      "restart-node_04",
      "relaunch node_04 after sync",
      {},
      "node_04"
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input.kind).toBe("NodeopProcessSteps.RestartInput")
    expect(step.input.nodeName).toBe("node_04")
    expect(typeof step.runner).toBe("function")
  })

  it("start delegates to NodeopProcess.startWithRecovery (dirty-chainbase resilient)", async () => {
    const ctx = fixtureContext()
    // The context's processManager getter requires the singleton's cluster
    // path to be set (idempotent for the same value).
    ProcessManager.setClusterPath(ctx.config.clusterPath)
    const bios = NodeConfig.plan(ctx.config).find(
      planned => planned.role === NodeRole.bios
    )
    const recoverySpy = jest
      .spyOn(NodeopProcess, "startWithRecovery")
      // strictNullChecks is off — `undefined` is assignable to `NodeopProcess`
      // here with no cast; the test only asserts on the call args, never the
      // resolved value.
      .mockResolvedValue(undefined)
    try {
      await Steps.processes.nodeop.runStart(
        ctx,
        { kind: "NodeopProcessSteps.StartInput", nodeName: bios.name },
        new AbortController().signal
      )
      expect(recoverySpy).toHaveBeenCalledWith(
        ctx.processManager,
        expect.objectContaining({
          node: expect.objectContaining({ name: bios.name, role: NodeRole.bios })
        })
      )
    } finally {
      recoverySpy.mockRestore()
    }
  })

  describe("resolveOperator (exported for ClusterManager.run reuse)", () => {
    it("bios node resolves the genesis producer's dev K1+BLS keys", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.bios, 0, "bios")
      const operator = Steps.processes.nodeop.resolveOperator(ctx, node)
      expect(operator.account).toBe(NodeConfig.BiosProducer)
      expect(operator.type).toBe(OperatorType.PRODUCER)
      expect(operator.wire.type).toBe(KeyType.K1)
      expect(operator.bls?.type).toBe(KeyType.BLS)
    })

    it("producer node resolves its NODE-shared K1+BLS keys from ctx.keyStore", () => {
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 1,
        keys: {
          k1: { type: KeyType.K1, publicKey: "PUB_K1_node1", privateKey: "PVT_K1_node1" },
          bls: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_node1",
            privateKey: "PVT_BLS_node1",
            proofOfPossession: "SIG_BLS_node1"
          }
        }
      })
      const node = testNode(ctx, NodeRole.producer, 1, "node_01", ["defproducera"])
      const operator = Steps.processes.nodeop.resolveOperator(ctx, node)
      expect(operator.account).toBe("defproducera")
      expect(operator.type).toBe(OperatorType.PRODUCER)
      expect(operator.wire.publicKey).toBe("PUB_K1_node1")
      expect(operator.bls?.publicKey).toBe("PUB_BLS_node1")
    })

    it("operator node (batch operator) resolves the provisioned account from ctx.keyStore", () => {
      const ctx = fixtureContext()
      const provisioned = operatorAccount("batchopaaaa", OperatorType.BATCH)
      ctx.keyStore.setOperator(provisioned)
      const node = testNode(ctx, NodeRole.operator, 2, "node_02", [], "batchopaaaa")
      expect(Steps.processes.nodeop.resolveOperator(ctx, node)).toBe(provisioned)
    })

    it("operator node (underwriter) resolves the provisioned account from ctx.keyStore", () => {
      const ctx = fixtureContext()
      const provisioned = operatorAccount("underwriteraaaa", OperatorType.UNDERWRITER)
      ctx.keyStore.setOperator(provisioned)
      const node = testNode(ctx, NodeRole.operator, 3, "node_03", [], null, "underwriteraaaa")
      expect(Steps.processes.nodeop.resolveOperator(ctx, node)).toBe(provisioned)
    })

    it("throws when an operator node names no batch/underwriter label", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.operator, 4, "node_04")
      expect(() => Steps.processes.nodeop.resolveOperator(ctx, node)).toThrow(
        /has no operator label/
      )
    })

    it("throws when the named operator account has not been provisioned in ctx.keyStore", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.operator, 5, "node_05", [], "unprovisioned")
      expect(() => Steps.processes.nodeop.resolveOperator(ctx, node)).toThrow(
        /has not been provisioned/
      )
    })
  })

  describe("resolveOperatorDaemonArgs (exported for ClusterManager.run reuse)", () => {
    it("returns [] for a bios node", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.bios, 0, "bios")
      expect(
        Steps.processes.nodeop.resolveOperatorDaemonArgs(
          ctx,
          node,
          operatorAccount(NodeConfig.BiosProducer, OperatorType.PRODUCER)
        )
      ).toEqual([])
    })

    it("returns [] for a producer node", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.producer, 1, "node_01", ["defproducera"])
      expect(
        Steps.processes.nodeop.resolveOperatorDaemonArgs(
          ctx,
          node,
          operatorAccount("defproducera", OperatorType.PRODUCER)
        )
      ).toEqual([])
    })

    it("builds batch-operator daemon args for an operator node with a batchOperatorLabel", () => {
      const ctx = fixtureContext()
      ctx.outputs.set(OperatorDaemonArtifactsKey, artifactsFixture)
      const account = operatorAccount("batchopaaaa", OperatorType.BATCH)
      const node = testNode(ctx, NodeRole.operator, 2, "node_02", [], "batchopaaaa")
      const args = Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      expect(args).toEqual(
        expect.arrayContaining([
          "--batch-enabled",
          "true",
          "--batch-operator-account",
          "batchopaaaa"
        ])
      )
    })

    it("builds underwriter daemon args for an operator node with an underwriterLabel", () => {
      const ctx = fixtureContext()
      ctx.outputs.set(OperatorDaemonArtifactsKey, artifactsFixture)
      const account = operatorAccount("underwriteraaaa", OperatorType.UNDERWRITER)
      const node = testNode(ctx, NodeRole.operator, 3, "node_03", [], null, "underwriteraaaa")
      const args = Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      expect(args).toEqual(
        expect.arrayContaining([
          "--underwriter-enabled",
          "true",
          "--underwriter-account",
          "underwriteraaaa"
        ])
      )
    })

    it("throws when the operator daemon artifacts have not been prepared yet", () => {
      const ctx = fixtureContext()
      const account = operatorAccount("batchopbbbb", OperatorType.BATCH)
      const node = testNode(ctx, NodeRole.operator, 4, "node_04", [], "batchopbbbb")
      expect(() =>
        Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      ).toThrow(/Missing asserted output/)
    })
  })
})
