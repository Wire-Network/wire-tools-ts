import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, SysioContracts } from "@wireio/sdk-core"
import {
  OutpostChainCodename,
  OutpostChainCodenames
} from "@wireio/cluster-tool-shared"
import { ProtocolTiming } from "@wireio/cluster-tool"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { ClusterConfigProvider, NodeConfig } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import {
  FixtureJudgePublicKey,
  FixturePanicPublicKey,
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import {
  collectPhaseNames,
  collectStepNames,
  findPhase
} from "./clusterBuildFixture.js"
import { seedProducerOperators } from "./outputs/operatorAccountFixture.js"

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
    externalConfigFile = fixtureExternalOutpostConfig(environment.rootPath)
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

  /** Base options for an EXTERNAL-mode build. */
  function externalOptions() {
    return {
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile,
      judgePublicKey: FixtureJudgePublicKey,
      panicPublicKey: FixturePanicPublicKey
    }
  }

  describe("bootstrap success gates", () => {
    it("LOCAL mode gates on every chain's genesis epoch being decided", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions()),
        names = collectPhaseNames(cluster.children)
      expect(names).toContain("EpochBootstrap")
      // unconditional, and directly after the bootstrap phase
      expect(names.indexOf("EpochDecided")).toBe(
        names.indexOf("EpochBootstrap") + 1
      )
      expect(names).not.toContain("HeadBlockAdvance")
      expect(names).not.toContain("OutboundEnvelopesQueued")
    })

    it("EXTERNAL mode gates on head advance + a queued outbound envelope per outpost", async () => {
      const cluster = await ClusterBuildDefaults.create(externalOptions()),
        names = collectPhaseNames(cluster.children)
      expect(names).toContain("HeadBlockAdvance")
      expect(names).toContain("OutboundEnvelopesQueued")
      // there is no local outpost to answer the genesis envelope
      expect(names).not.toContain("EpochDecided")
    })

    it("the gate's budget reuses ProtocolTiming's epoch-liveness envelope with each chain's duration", async () => {
      const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        epochDurationSec: 60,
        outpostEpochDurationSec: { [OutpostChainCodename.SOLANA]: 150 }
      })
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(cluster.config, OutpostChainCodename.ETHEREUM)).toBe(
        ProtocolTiming.EpochVerifyEpochCount *
          ProtocolTiming.effectiveEpochSec(60) *
          ProtocolTiming.MsPerSecond
      )
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(cluster.config, OutpostChainCodename.SOLANA)).toBe(
        ProtocolTiming.EpochVerifyEpochCount *
          ProtocolTiming.effectiveEpochSec(150) *
          ProtocolTiming.MsPerSecond
      )
    })

    it("gives a default-duration cluster's Solana gate the OPP circulation restart, its Ethereum gate three epochs", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions())
      expect(cluster.config.outpostEpochDurationSec).toEqual(
        ClusterConfigProvider.DefaultOutpostEpochDurationSec
      )
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(cluster.config, OutpostChainCodename.ETHEREUM)).toBe(
        ProtocolTiming.EpochVerifyEpochCount *
          ProtocolTiming.effectiveEpochSec(ClusterConfigProvider.DefaultEthereumEpochDurationSec) *
          ProtocolTiming.MsPerSecond
      )
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(cluster.config, OutpostChainCodename.SOLANA)).toBe(
        ProtocolTiming.OppCirculationRestartMs
      )
    })

    it("gates on every outpost chain's own genesis epoch decided, one verify per chain, with no traffic", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions()),
        gate = findPhase(cluster.children, "EpochDecided")
      expect(gate.steps.map(step => step.name)).toEqual(
        OutpostChainCodenames.map(chain => `verify-epoch-decided-${chain.toLowerCase()}`)
      )
      expect(gate.steps.map(step => step.description)).toEqual(
        OutpostChainCodenames.map(
          chain => `the ${chain} epoch ${Steps.epochAdvance.BootstrapDecidedEpochIndex} is decided`
        )
      )
      expect(gate.steps.map(step => step.input)).toEqual(
        OutpostChainCodenames.map(chain => ({ kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain }))
      )
      expect(gate.steps.map(step => step.runner)).toEqual(
        OutpostChainCodenames.map(() => Steps.epochAdvance.runAwaitEpochDecided)
      )
    })
  })

  describe("economic clock", () => {
    it.each(["local", "external"])(
      "configures the clock after the epoch config and before init-t5 and the genesis bootstrap in %s mode",
      async mode => {
        const cluster = await ClusterBuildDefaults.create(
            mode === "local" ? baseOptions() : externalOptions()
          ),
          names = collectStepNames(cluster.children),
          economy = names.indexOf("configure-economy")
        OutpostChainCodenames.forEach(chain =>
          expect(economy).toBeGreaterThan(names.indexOf(`configure-epoch-${chain.toLowerCase()}`))
        )
        expect(names.indexOf("init-t5")).toBeGreaterThan(economy)
        expect(names.indexOf("bootstrap-epoch")).toBeGreaterThan(economy)
        expect(names.filter(name => name === "configure-economy")).toHaveLength(1)
      }
    )

    it("passes the resolved duration and start to seteconomy", async () => {
      const cluster = await ClusterBuildDefaults.create({
          ...baseOptions(),
          epochDurationSec: 60,
          economicEpochDurationSec: 360,
          economicStartTime: "2026-11-01T06:00:00"
        }),
        step = findPhase(cluster.children, "OPPConfig").steps.find(
          candidate => candidate.name === "configure-economy"
        )
      expect(step.input).toEqual({
        kind: "EpochContractSteps.SeteconomyInput",
        epochDurationSec: 360,
        startTime: "2026-11-01T06:00:00"
      })
      expect(step.runner).toBe(Steps.contracts.sysio.epoch.runSeteconomy)
    })

    it("passes seteconomy the start normalized at resolution, a +00:00 offset included", async () => {
      const cluster = await ClusterBuildDefaults.create({
          ...baseOptions(),
          economicStartTime: "2026-11-20T12:34:56+00:00"
        }),
        step = findPhase(cluster.children, "OPPConfig").steps.find(
          candidate => candidate.name === "configure-economy"
        )
      expect(step.input).toMatchObject({ startTime: "2026-11-20T12:34:56" })
    })
  })

  describe("genesis account seeding", () => {
    it.each(["local", "external"])(
      "creates and deploys sysio.councl without an unnecessary code grant in %s mode",
      async mode => {
        const cluster = await ClusterBuildDefaults.create(
            mode === "local" ? baseOptions() : externalOptions()
          ),
          names = collectStepNames(cluster.children),
          createIndex = names.indexOf("create-sysio.councl"),
          deployIndex = names.indexOf("deploy-councl")
        expect(createIndex).toBeGreaterThanOrEqual(0)
        expect(deployIndex).toBeGreaterThan(createIndex)
        expect(names).not.toContain("grant-sysio.councl")
        expect(names.filter(name => name === "deploy-councl")).toHaveLength(1)
      }
    )

    it("seeds the bios producer as the ONE key-store OPERATOR", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      const bios = keyStore.assertOperator(NodeConfig.BiosName)
      // KEY mode → the well-known dev bios pair, byte-identical to history
      expect(bios.wire.publicKey).toBe(KeyGenerator.BiosK1Key.publicKey)
      expect(bios.wireFinalizer?.publicKey).toBe(
        KeyGenerator.BiosBLSKey.publicKey
      )
      expect(bios.account).toBe(NodeConfig.BiosProducer)
      expect(keyStore.operators).toEqual([bios])
    })

    it("NEVER pushes the bios keys as a NODE key set (that would add a finalizer)", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      expect(keyStore.nodes).toHaveLength(0)
    })

    it("types the seeded account UNKNOWN so it never reaches the producer schedule", async () => {
      const { keyStore } = (await ClusterBuildDefaults.create(baseOptions()))
        .context
      // `ConsensusSteps.runSetProducerKeys` builds `setprodkeys` from this list.
      expect(keyStore.operatorsByType(OperatorType.PRODUCER)).toHaveLength(0)
      expect(
        keyStore.assertOperator(NodeConfig.BiosName).type
      ).toBe(OperatorType.UNKNOWN)
    })

    it("keeps the finalizer policy at the PRODUCER-ACCOUNT cardinality", async () => {
      const cluster = await ClusterBuildDefaults.create(baseOptions()),
        ctx = cluster.context
      // The policy is keyed on ACCOUNTS, not nodes: `update_ranked_producers` rebuilds it from
      // the keys accounts registered via `regfinkey`, so a node-keyed genesis policy would be
      // replaced by an account-keyed one this node holds no key for. Seeding a node key set is
      // therefore NOT enough — and must not be, or the two would silently diverge.
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
      const producers = seedProducerOperators(ctx)
      // The REAL typed contract client, with only the network call doubled.
      // `getSysioContract` mints a fresh Proxy (and a fresh invoker cache) per
      // call, so the client the runner would build is not the one spied here —
      // hence `getSysioContract` is ALSO pinned to this instance. Both spies are
      // typed against the real members; nothing is stubbed structurally.
      const contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.bios
        ),
        invoke = jest
          .spyOn(contract.actions.setfinalizer, "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await Steps.consensus.runSetFinalizer(
        ctx,
        null,
        new AbortController().signal
      )
      const action = invoke.mock.calls[0][0] as SetFinalizerAction
      // ONE finalizer per PROVISIONED PRODUCER ACCOUNT — the seeded bios account contributes
      // none (it is typed UNKNOWN), which is the whole point of `setOperator` over `pushNodes`.
      expect(action.finalizer_policy.finalizers).toHaveLength(producers.length)
      expect(action.finalizer_policy.finalizers.map(entry => entry.public_key)).toEqual(
        producers.map(producer => producer.wireFinalizer.publicKey)
      )
      expect(action.finalizer_policy.threshold).toBe(
        Math.floor((producers.length * 2) / 3) + 1
      )
    })
  })
})
