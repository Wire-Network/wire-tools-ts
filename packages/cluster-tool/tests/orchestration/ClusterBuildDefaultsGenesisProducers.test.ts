import Path from "node:path"
import { SysioContracts } from "@wireio/sdk-core"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"
import {
  collectPhaseNames,
  collectStepNames
} from "./clusterBuildFixture.js"
import { seedProducerOperators } from "./outputs/operatorAccountFixture.js"

/**
 * Genesis producers have to REGISTER, not merely exist.
 *
 * `sysio.system::update_ranked_producers` schedules only producers that satisfy one predicate —
 * an active `producers` row, an ACTIVE `OPERATOR_TYPE_PRODUCER` row in `sysio.opreg`, and an
 * ACTIVE finalizer key. Before these phases existed the bootstrap created producer ACCOUNTS and
 * stopped there, so every cluster had zero schedulable producers: ranking could never publish and
 * the schedule stayed frozen at whatever `setprodkeys` stamped at bootstrap.
 */
describe("ClusterBuildDefaults — genesis producer registration", () => {
  let environment: ResolveEnvironment,
    cluster: Awaited<ReturnType<typeof ClusterBuildDefaults.create>>

  // ONE build for the whole block. Every assertion below reads the PLAN — nothing mutates it —
  // and a build resolves a full bind config under the host-global registry lock, which is slow
  // enough that four of them measurably lengthen the lock queue for every other suite.
  beforeAll(async () => {
    environment = fixtureResolveEnvironment("genesis-producers-")
    cluster = await ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    })
  })

  afterAll(() => {
    environment.cleanup()
  })

  /** Every producer account the planned topology hosts. */
  function plannedProducers(config: Parameters<typeof NodeConfig.plan>[0]): string[] {
    return NodeConfig.plan(config)
      .filter(node => node.role === NodeRole.producer)
      .flatMap(node => node.producers)
  }

  it("grants RAM, then regproducer, then regfinkey for every genesis producer, in that order", () => {
    const producers = plannedProducers(cluster.context.config),
      steps = collectStepNames(cluster.children)
    expect(producers.length).toBeGreaterThan(0)
    producers.forEach(label => {
      const ram = steps.indexOf(`setacctram-${label}`),
        registered = steps.indexOf(`regproducer-${label}`),
        keyed = steps.indexOf(`regfinkey-${label}`)
      // RAM first: a genesis producer is created with `newaccount`, not sponsored through
      // `roa::newuser`, so it holds no allocation — and `regfinkey` bills its rows to the
      // producer. Without the grant the registration aborts on RAM mid-bootstrap.
      expect(ram).toBeGreaterThanOrEqual(0)
      expect(registered).toBeGreaterThan(ram)
      // The contract enforces this one: `regfinkey` requires an existing `producers` row.
      expect(keyed).toBeGreaterThan(registered)
    })
  })

  it("plans ONE bootstrapped PRODUCER regoperator per genesis producer", () => {
    const producers = plannedProducers(cluster.context.config),
      steps = collectStepNames(cluster.children)
    producers.forEach(label => {
      expect(steps).toContain(`regoperator-${label}`)
    })
    // One per producer — never a single step looping over them.
    expect(
      steps.filter(name => name.startsWith("regoperator-defproducer")).length
    ).toBe(producers.length)
  })

  it("registers the opreg half only AFTER sysio.opreg is deployed and configured", () => {
    // The split exists because sysio.opreg does not exist until `OPPContracts`; registering
    // earlier would push an action at an account carrying no code.
    const names = collectPhaseNames(cluster.children)
    expect(names.indexOf("GenesisProducerOperators")).toBeGreaterThan(
      names.indexOf("OPPConfig")
    )
    expect(names.indexOf("GenesisProducerRegistration")).toBeLessThan(
      names.indexOf("OPPContracts")
    )
  })

  it("materializes producer identities BEFORE any node starts", () => {
    // The ordering this pins is load-bearing and was got wrong once: a producing node renders
    // one `--signature-provider` per hosted account at LAUNCH, so each account's finalizer key
    // has to exist by then. Materialization is pure key work and can run this early; the
    // matching chain write (`newaccount`) cannot, which is why the two are separate phases.
    const names = collectPhaseNames(cluster.children)
    expect(names.indexOf("ProducerIdentities")).toBeGreaterThan(
      names.indexOf("WalletAndKeys")
    )
    expect(names.indexOf("ProducerIdentities")).toBeLessThan(
      names.indexOf("ProducerNodes")
    )
    // …and before the SSM publication walker runs, since it reads those keys off the store.
    expect(names.indexOf("ProducerIdentities")).toBeLessThan(
      names.indexOf("Producers")
    )
  })

  it("activates finality after the identities exist but while the BIOS contract is still live", () => {
    // Two constraints meet here. The policy is built from the producer ACCOUNTS' finalizer keys
    // (`update_ranked_producers` rebuilds it from exactly those keys, so a node-keyed genesis
    // policy would be replaced by one this node holds no key for — LIB freezes and the pending
    // schedule never activates), which needs `ProducerIdentities` to have run. And
    // `bios::setfinalizer` is a BIOS-ABI action, so it must run before `SystemContract` replaces
    // the code on `sysio` — after that the action simply does not exist.
    const names = collectPhaseNames(cluster.children)
    expect(names.indexOf("Finality")).toBeGreaterThan(
      names.indexOf("ProducerIdentities")
    )
    expect(names.indexOf("Finality")).toBeLessThan(
      names.indexOf("SystemContract")
    )
  })

  describe("the registration runners resolve their keys from ctx.keyStore", () => {
    const signal = new AbortController().signal

    it("regproducer signs as the producer and carries its stored block-signing key", async () => {
      const ctx = fixtureContext(),
        [producer] = seedProducerOperators(ctx),
        contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.system
        ),
        invoke = jest
          .spyOn(contract.actions.regproducer, "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

      await Steps.consensus.runRegisterProducer(
        ctx,
        { kind: "ConsensusSteps.ProducerRegistrationInput", label: producer.label },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          producer: producer.account,
          producer_key: producer.wire.publicKey
        }),
        {
          authorization: [{ actor: producer.account, permission: "active" }]
        }
      )
    })

    it("regfinkey carries the account's OWN BLS key + proof of possession", async () => {
      const ctx = fixtureContext(),
        seeded = seedProducerOperators(ctx),
        contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.system
        ),
        invoke = jest
          .spyOn(contract.actions.regfinkey, "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

      // Distinct keys per account is the whole point — `regfinkey` enforces a GLOBAL uniqueness
      // check, so siblings sharing their node's one key means only the first can register.
      expect(new Set(seeded.map(entry => entry.wireFinalizer.publicKey)).size).toBe(
        seeded.length
      )
      const [producer] = seeded
      await Steps.consensus.runRegisterFinalizerKey(
        ctx,
        { kind: "ConsensusSteps.ProducerRegistrationInput", label: producer.label },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(
        {
          finalizer_name: producer.account,
          finalizer_key: producer.wireFinalizer.publicKey,
          proof_of_possession: producer.wireFinalizer.proofOfPossession
        },
        {
          authorization: [{ actor: producer.account, permission: "active" }]
        }
      )
    })

    it("regfinkey refuses a producer that carries no finalizer key", async () => {
      const ctx = fixtureContext(),
        [producer] = seedProducerOperators(ctx)
      ctx.keyStore.setOperator({ ...producer, wireFinalizer: undefined })
      await expect(
        Steps.consensus.runRegisterFinalizerKey(
          ctx,
          {
            kind: "ConsensusSteps.ProducerRegistrationInput",
            label: producer.label
          },
          signal
        )
      ).rejects.toThrow(/has no finalizer key/)
    })

    it("the RAM grant resolves the producer's ON-CHAIN account, not its handle", async () => {
      // A sponsored producer's on-chain name is generated by the depot at run time, so the
      // account cannot be a plan-time literal — which is the whole reason this step is keyed by
      // handle. Seeding an account that differs from the label is what makes the distinction
      // observable.
      const ctx = fixtureContext(),
        [seeded] = seedProducerOperators(ctx),
        producer = { ...seeded, account: `wireno.${seeded.label}` }
      ctx.keyStore.setOperator(producer)
      const contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.system
        ),
        invoke = jest
          .spyOn(contract.actions.setacctram, "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

      await Steps.consensus.runGrantProducerRam(
        ctx,
        {
          kind: "ConsensusSteps.GrantProducerRamInput",
          label: producer.label,
          ramBytes: 1_000_000
        },
        signal
      )
      expect(invoke).toHaveBeenCalledWith({
        account: producer.account,
        ram_bytes: 1_000_000
      })
      expect(invoke.mock.calls[0][0].account).not.toBe(producer.label)
    })

    it("both runners fail loudly for a producer that was never provisioned", async () => {
      const ctx = fixtureContext(),
        input = {
          kind: "ConsensusSteps.ProducerRegistrationInput" as const,
          label: "neverprovisioned"
        }
      await expect(
        Steps.consensus.runRegisterProducer(ctx, input, signal)
      ).rejects.toThrow(/has not been provisioned/)
      await expect(
        Steps.consensus.runRegisterFinalizerKey(ctx, input, signal)
      ).rejects.toThrow(/has not been provisioned/)
    })
  })
})
