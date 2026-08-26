import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
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
import { PersistedFixture } from "../../../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../../../orchestration/outputs/operatorAccountFixture.js"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic = "test test test test test test test test test test test junk"

/**
 * A fully-keyed OperatorAccount fixture for the given label/type — REAL
 * (decodable) ethereum + solana keys, since `resolveOperatorDaemonArgs`
 * threads them through `KeyGenerator.toSignatureProvider`. `account` is the
 * DISTINCT `roa::newuser`-generated chain name, never the durable handle: a
 * fixture where the two are the same string cannot fail on a label/account
 * swap at a chain boundary (mirrors the helper in `OperatorDaemonTool.test.ts`).
 */
function operatorAccount(label: string, type: OperatorType): OperatorAccount {
  const wallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(AnvilMnemonic),
      "m/44'/60'/0'/0/1"
    ),
    edPrivate = PrivateKey.generate(KeyType.ED)
  return {
    label,
    publicationLabel: label,
    account: `wireno.${label}`,
    type,
    wire: { type: KeyType.K1, publicKey: `PUB_K1_${label}`, privateKey: `PVT_K1_${label}` },
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
  ethereumClientConfigurationFile: "/cluster/data/ethereum-client.json",
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

/** The value following `flag` (each occurrence) — mirrors the local helper in `OperatorDaemonTool.test.ts`. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
}

describe("Steps.processes.nodeop", () => {
  /**
   * A real cluster tree the `ProcessManager` singleton is pinned to for the
   * whole file — `setClusterPath` may be set ONCE, so every context here must
   * name the SAME root, and a `NodeopProcess` needs a genesis file plus an
   * executable to construct at all.
   */
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "nodeop-steps-"))
    Fs.writeFileSync(
      Path.join(dir, "genesis.json"),
      JSON.stringify({ initial_timestamp: "2026-01-01T00:00:00.000" })
    )
    ProcessManager.setClusterPath(dir)
  })
  afterEach(async () => {
    await ProcessManager.get().stopAll()
    jest.restoreAllMocks()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Fixture overrides aiming a context at the sandbox above. */
  function sandbox(): Partial<ClusterConfig> {
    return {
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      executables: { ...PersistedFixture.executables, nodeop: "/bin/true" }
    }
  }

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
    const ctx = fixtureContext(sandbox())
    const bios = NodeConfig.plan(ctx.config).find(
      planned => planned.role === NodeRole.bios
    )
    const recoverySpy = jest
      .spyOn(NodeopProcess, "startWithRecovery")
      // strictNullChecks is off — `undefined` is assignable to `NodeopProcess`
      // here with no cast; the test only asserts on the call args, never the
      // resolved value.
      .mockResolvedValue(undefined)
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
  })

  it("start leaves the launch form at BOOTSTRAP (SHARED-25 rules not yet armed)", async () => {
    // The create-path spawn runs DURING bootstrap, so it must not carry the
    // post-bootstrap deadlines — the author's directive is that none of the
    // rules apply until a complete bootstrap.
    const ctx = fixtureContext(sandbox()),
      bios = NodeConfig.plan(ctx.config).find(
        planned => planned.role === NodeRole.bios
      ),
      recoverySpy = jest
        .spyOn(NodeopProcess, "startWithRecovery")
        .mockResolvedValue(undefined)
    await Steps.processes.nodeop.runStart(
      ctx,
      { kind: "NodeopProcessSteps.StartInput", nodeName: bios.name },
      new AbortController().signal
    )
    expect(recoverySpy.mock.calls[0][1].postBootstrap).toBeUndefined()
  })

  it("restart relaunches in the POST-BOOTSTRAP form (SHARED-25)", async () => {
    // The sync gate has already put a complete chain under the node, so the
    // relaunch is post-bootstrap — and that is NOT implied by `relaunch`, which
    // in-bootstrap dirty-chainbase recovery also sets.
    const ctx = fixtureContext(sandbox()),
      node = NodeConfig.plan(ctx.config).find(
        planned => planned.role === NodeRole.batch_operator
      ),
      operator = operatorAccount(node.batchOperatorLabel, OperatorType.BATCH)
    ctx.keyStore.setOperator(operator)
    ctx.outputs.set(OperatorDaemonArtifactsKey, artifactsFixture)
    // A CONSTRUCTED (never started) process satisfies the running-nodeop
    // assertion; `stop()` is a no-op without a child and `remove()` accepts it.
    await NodeopProcess.create(ctx.processManager, { node, operator })

    const depotHead = 42
    jest.spyOn(WireClient.prototype, "getHead").mockResolvedValue(depotHead)
    jest.spyOn(NodeopProcess.prototype, "head").mockResolvedValue(depotHead)
    const recoverySpy = jest
      .spyOn(NodeopProcess, "startWithRecovery")
      .mockResolvedValue(undefined)

    await Steps.processes.nodeop.runRestart(
      ctx,
      { kind: "NodeopProcessSteps.RestartInput", nodeName: node.name },
      new AbortController().signal
    )
    expect(recoverySpy).toHaveBeenCalledWith(
      ctx.processManager,
      expect.objectContaining({ relaunch: true, postBootstrap: true })
    )
  })

  describe("resolveOperator (exported for ClusterManager.run reuse)", () => {
    it("bios node falls back to the dev K1+BLS keys when the key store has no bios entry", () => {
      // A cluster directory written before `ClusterBuild.create` seeded the
      // bios account — such a cluster is a KEY-mode dev-key cluster by
      // definition, so the dev pair IS its genesis material.
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.bios, 0, "bios")
      const operator = Steps.processes.nodeop.resolveOperator(ctx, node)
      expect(operator.label).toBe(NodeConfig.BiosName)
      expect(operator.type).toBe(OperatorType.PRODUCER)
      expect(operator.wire.type).toBe(KeyType.K1)
      expect(operator.wireFinalizer?.type).toBe(KeyType.BLS)
    })

    it("bios node prefers the SEEDED genesis account from ctx.keyStore", () => {
      // `ClusterBuild.create` seeds this from
      // `ClusterConfigProvider.resolveWithBiosKeys`, so an SSM cluster's
      // GENERATED bios keys — not the dev pair — reach the nodeop args.
      const ctx = fixtureContext(),
        seeded: OperatorAccount = {
          label: NodeConfig.BiosName,
          publicationLabel: NodeConfig.BiosName,
          account: NodeConfig.BiosProducer,
          type: OperatorType.UNKNOWN,
          wire: {
            type: KeyType.K1,
            publicKey: "PUB_K1_generatedBios",
            privateKey: "PVT_K1_generatedBios"
          },
          wireFinalizer: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_generatedBios",
            privateKey: "PVT_BLS_generatedBios",
            proofOfPossession: "SIG_BLS_generatedBios"
          }
        }
      ctx.keyStore.setOperator(seeded)
      const node = testNode(ctx, NodeRole.bios, 0, "bios")
      expect(Steps.processes.nodeop.resolveOperator(ctx, node)).toBe(seeded)
    })

    it("producer node resolves its NODE-shared K1+BLS keys from ctx.keyStore", () => {
      const ctx = fixtureContext()
      ctx.keyStore.pushNodes({
        index: 1,
        keys: {
          wire: { type: KeyType.K1, publicKey: "PUB_K1_node1", privateKey: "PVT_K1_node1" },
          wireFinalizer: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_node1",
            privateKey: "PVT_BLS_node1",
            proofOfPossession: "SIG_BLS_node1"
          }
        }
      })
      const node = testNode(ctx, NodeRole.producer, 1, "node_01", ["defproducera"])
      const operator = Steps.processes.nodeop.resolveOperator(ctx, node)
      expect(operator.label).toBe("defproducera")
      expect(operator.type).toBe(OperatorType.PRODUCER)
      expect(operator.wire.publicKey).toBe("PUB_K1_node1")
      expect(operator.wireFinalizer?.publicKey).toBe("PUB_BLS_node1")
    })

    it("batch-operator node resolves the provisioned account from ctx.keyStore", () => {
      const ctx = fixtureContext()
      const provisioned = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH)
      ctx.keyStore.setOperator(provisioned)
      const node = testNode(ctx, NodeRole.batch_operator, 2, "node_02", [], "batchopaaaa")
      expect(Steps.processes.nodeop.resolveOperator(ctx, node)).toBe(provisioned)
    })

    it("underwriter node resolves the provisioned account from ctx.keyStore", () => {
      const ctx = fixtureContext()
      const provisioned = fixtureOperatorAccount("underwriteraaaa", OperatorType.UNDERWRITER)
      ctx.keyStore.setOperator(provisioned)
      const node = testNode(ctx, NodeRole.underwriter, 3, "node_03", [], null, "underwriteraaaa")
      expect(Steps.processes.nodeop.resolveOperator(ctx, node)).toBe(provisioned)
    })

    it("throws when an operator node names no batch/underwriter label", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.batch_operator, 4, "node_04")
      expect(() => Steps.processes.nodeop.resolveOperator(ctx, node)).toThrow(
        /has no operator label/
      )
    })

    it("throws when the named operator label has not been provisioned in ctx.keyStore", () => {
      const ctx = fixtureContext()
      const node = testNode(ctx, NodeRole.batch_operator, 5, "node_05", [], "unprovisioned")
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
          fixtureOperatorAccount(NodeConfig.BiosName, OperatorType.PRODUCER)
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
          fixtureOperatorAccount("defproducera", OperatorType.PRODUCER)
        )
      ).toEqual([])
    })

    it("builds batch-operator daemon args for a batch_operator node", () => {
      const ctx = fixtureContext()
      ctx.outputs.set(OperatorDaemonArtifactsKey, artifactsFixture)
      const account = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH)
      const node = testNode(ctx, NodeRole.batch_operator, 2, "node_02", [], "batchopaaaa")
      const args = Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      expect(args).toEqual(
        expect.arrayContaining([
          "--batch-enabled",
          "true",
          "--batch-operator-account",
          "wireno.batchopaaaa",
          "--outpost-ethereum-client-config-file",
          artifactsFixture.ethereumClientConfigurationFile
        ])
      )
      // The depot matches this argv against `sysio.opreg::operators`, which is
      // keyed by the ON-CHAIN account — passing the handle would start a daemon
      // that silently matches no operator row.
      expect(valuesOf(args, "--batch-operator-account")).toEqual([account.account])
      expect(valuesOf(args, "--batch-operator-account")).not.toEqual([account.label])
    })

    it("builds underwriter daemon args for an underwriter node", () => {
      const ctx = fixtureContext()
      ctx.outputs.set(OperatorDaemonArtifactsKey, artifactsFixture)
      const account = fixtureOperatorAccount("underwriteraaaa", OperatorType.UNDERWRITER)
      const node = testNode(ctx, NodeRole.underwriter, 3, "node_03", [], null, "underwriteraaaa")
      const args = Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      expect(args).toEqual(
        expect.arrayContaining([
          "--underwriter-enabled",
          "true",
          "--underwriter-account",
          "wireno.underwriteraaaa",
          "--outpost-ethereum-client-config-file",
          artifactsFixture.ethereumClientConfigurationFile
        ])
      )
      // Same chain-boundary rule as `--batch-operator-account`.
      expect(valuesOf(args, "--underwriter-account")).toEqual([account.account])
      expect(valuesOf(args, "--underwriter-account")).not.toEqual([account.label])
    })

    it("throws when the operator daemon artifacts have not been prepared yet", () => {
      const ctx = fixtureContext()
      const account = fixtureOperatorAccount("batchopbbbb", OperatorType.BATCH)
      const node = testNode(ctx, NodeRole.batch_operator, 4, "node_04", [], "batchopbbbb")
      expect(() =>
        Steps.processes.nodeop.resolveOperatorDaemonArgs(ctx, node, account)
      ).toThrow(/Missing asserted output/)
    })
  })
})
