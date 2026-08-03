import Fs from "node:fs"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool"
import type { WireClient } from "@wireio/cluster-tool/clients/wire"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { NodeConfig } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

/** A phase or group node — a group carries `children`, a phase is a leaf. */
interface NamedNode {
  name: string
  children?: ReadonlyArray<NamedNode>
}

/** Every phase/group name in a built cluster, recursively (tree order). */
function collectNames(children: ReadonlyArray<NamedNode>): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child.children ? collectNames(child.children) : [])
  ])
}

/** One `finalizer_policy` entry as `bios::setfinalizer` receives it. */
interface FinalizerEntry {
  description: string
  weight: number
  public_key: string
  pop: string
}

/** The `finalizer_policy` member of the `bios::setfinalizer` action data. */
interface FinalizerPolicy {
  threshold: number
  finalizers: FinalizerEntry[]
}

/** The `bios::setfinalizer` action data the runner invokes with. */
interface SetFinalizerAction {
  finalizer_policy: FinalizerPolicy
}

describe("ClusterBuildDefaults — genesis seeding + bootstrap gates", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("genesis-gates-")
    externalConfigFile = Path.join(environment.rootPath, "external-outpost.json")
    Fs.writeFileSync(
      externalConfigFile,
      JSON.stringify({
        ethereum: {
          addressFile: "outpost-addrs.json",
          abiFiles: ["eth-abis/OPP.json"],
          chainId: 11_155_111
        },
        solana: { idlFile: "solana-idls/liqsol_core.json" }
      })
    )
  })

  afterEach(() => {
    environment.cleanup()
  })

  /** Base options for a LOCAL-mode build over the sandbox. */
  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  /** Base options for an EXTERNAL-mode build (underwriters are excluded there). */
  function externalOptions() {
    return {
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile,
      underwriterCount: 0
    }
  }

  describe("bootstrap success gates", () => {
    it("LOCAL mode gates on the depot advancing past the bootstrap epoch", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions()),
        names = collectNames(cluster.children as unknown as NamedNode[])
      expect(names).toContain("EpochBootstrap")
      // unconditional, and directly after the bootstrap phase
      expect(names.indexOf("EpochAdvance")).toBe(
        names.indexOf("EpochBootstrap") + 1
      )
      expect(names).not.toContain("HeadBlockAdvance")
      expect(names).not.toContain("OutboundEnvelopesQueued")
    })

    it("EXTERNAL mode gates on head advance + a queued outbound envelope per outpost", async () => {
      const cluster = await ClusterBuildDefaults.create(externalOptions()),
        names = collectNames(cluster.children as unknown as NamedNode[])
      expect(names).toContain("HeadBlockAdvance")
      expect(names).toContain("OutboundEnvelopesQueued")
      // there is no local chain to advance an epoch on
      expect(names).not.toContain("EpochAdvance")
    })

    it("epochAdvanceBudgetMs reuses ProtocolTiming's epoch-liveness envelope", async () => {
      const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        epochDurationSec: 60
      })
      expect(ClusterBuildDefaults.epochAdvanceBudgetMs(cluster.config)).toBe(
        ProtocolTiming.EpochVerifyEpochCount *
          ProtocolTiming.effectiveEpochSec(60) *
          ProtocolTiming.MsPerSecond
      )
    })
  })

  describe("genesis account seeding", () => {
    it("seeds the bios producer + the bootstrap node owner as key-store OPERATORS", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      const bios = keyStore.assertOperator(NodeConfig.BiosName),
        nodeOwner = keyStore.assertOperator(Constants.BOOTSTRAP_NODE_OWNER)
      // KEY mode → the well-known dev bios pair, byte-identical to history
      expect(bios.wire.publicKey).toBe(KeyGenerator.BiosK1Key.publicKey)
      expect(bios.wireFinalizer?.publicKey).toBe(
        KeyGenerator.BiosBLSKey.publicKey
      )
      expect(nodeOwner.wire.publicKey).toBe(KeyGenerator.BiosK1Key.publicKey)
    })

    it("NEVER pushes the bios keys as a NODE key set (that would add a finalizer)", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      expect(keyStore.nodes).toHaveLength(0)
    })

    it("types both seeded accounts UNKNOWN so neither reaches the producer schedule", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      // `ConsensusSteps.runSetProducerKeys` builds `setprodkeys` from this list.
      expect(keyStore.operatorsByType(OperatorType.PRODUCER)).toHaveLength(0)
      expect(
        keyStore.assertOperator(NodeConfig.BiosName).type
      ).toBe(OperatorType.UNKNOWN)
      expect(
        keyStore.assertOperator(Constants.BOOTSTRAP_NODE_OWNER).type
      ).toBe(OperatorType.UNKNOWN)
    })

    it("keeps the finalizer policy at the PRODUCER-NODE cardinality", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions()),
        ctx = cluster.context
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          wire: {
            type: KeyType.K1,
            publicKey: "PUB_K1_n0",
            privateKey: "PVT_K1_n0"
          },
          wireFinalizer: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_n0",
            privateKey: "PVT_BLS_n0",
            proofOfPossession: "SIG_BLS_n0"
          }
        }
      })
      const invoke = jest.fn().mockResolvedValue(undefined),
        // A minimal typed-contract-client stand-in: the runner only reaches
        // `getSysioContract(bios).actions.setfinalizer.invoke`. Installed as an
        // OWN accessor on this throwaway context (never a prototype spy), so no
        // other instance or test can see it.
        wireStub = {
          getSysioContract: () => ({
            actions: { setfinalizer: { invoke } }
          })
        } as unknown as WireClient
      Object.defineProperty(ctx, "wire", {
        get: () => wireStub,
        configurable: true
      })
      await Steps.consensus.runSetFinalizer(
        ctx,
        null,
        new AbortController().signal
      )
      const action = invoke.mock.calls[0][0] as SetFinalizerAction
      // ONE finalizer for the ONE producer node — the seeded bios account
      // contributes none, which is the whole point of `setOperator` over
      // `pushNodes`.
      expect(action.finalizer_policy.finalizers).toHaveLength(
        ctx.keyStore.nodes.length
      )
      expect(action.finalizer_policy.finalizers).toHaveLength(1)
      expect(action.finalizer_policy.threshold).toBe(1)
    })
  })
})
