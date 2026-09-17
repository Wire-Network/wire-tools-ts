import { SysioContracts } from "@wireio/sdk-core"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { seedProducerOperators } from "../outputs/operatorAccountFixture.js"

describe("Steps.consensus", () => {
  const signal = new AbortController().signal

  afterEach(() => jest.restoreAllMocks())

  it.each(["planSetFinalizer", "planSetProducerKeys"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.consensus[factoryName](
        Report.Actor.Sysio,
        factoryName,
        `consensus step ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )

  describe("the label-keyed registration factories", () => {
    it.each([
      ["planRegisterProducer", "runRegisterProducer"],
      ["planRejectProducerRegistration", "runRejectProducerRegistration"],
      ["planRegisterFinalizerKey", "runRegisterFinalizerKey"]
    ] as const)("%s carries the handle as its typed input and wires %s", (factoryName, runnerName) => {
      const step = Steps.consensus[factoryName](
        Report.Actor.Producer,
        factoryName,
        `consensus step ${factoryName}`,
        {},
        "flowprod"
      )
      expect(step.actor).toBe(Report.Actor.Producer)
      expect(step.input).toEqual({
        kind: "ConsensusSteps.ProducerRegistrationInput",
        label: "flowprod"
      })
      expect(step.runner).toBe(Steps.consensus[runnerName])
    })
  })

  /**
   * The runners resolve their data from `ctx.keyStore` and DELEGATE the write to the
   * `Steps.contracts.sysio.system` runner for the same action — one body per action, never a
   * second copy of the invoke behind a label-keyed input.
   */
  describe("the registration runners resolve their keys from ctx.keyStore", () => {
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

    it("regproducer delegates the write to Steps.contracts.sysio.system.runRegproducer", async () => {
      const ctx = fixtureContext(),
        [producer] = seedProducerOperators(ctx),
        delegate = jest
          .spyOn(Steps.contracts.sysio.system, "runRegproducer")
          .mockResolvedValue(undefined)
      await Steps.consensus.runRegisterProducer(
        ctx,
        { kind: "ConsensusSteps.ProducerRegistrationInput", label: producer.label },
        signal
      )
      expect(delegate).toHaveBeenCalledWith(
        ctx,
        {
          kind: "SystemContractSteps.RegproducerInput",
          data: {
            producer: producer.account,
            producer_key: producer.wire.publicKey,
            url: "",
            location: 0
          }
        },
        signal
      )
    })

    it("the negative registration runner accepts only the admission rejection", async () => {
      const ctx = fixtureContext(),
        [producer] = seedProducerOperators(ctx),
        contract = ctx.wire.getSysioContract(
          SysioContracts.SysioContractName.system
        ),
        invoke = jest.spyOn(contract.actions.regproducer, "invoke")
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

      invoke.mockRejectedValueOnce(
        new Error("producer operator is not eligible for admission")
      )
      await expect(
        Steps.consensus.runRejectProducerRegistration(
          ctx,
          {
            kind: "ConsensusSteps.ProducerRegistrationInput",
            label: producer.label
          },
          signal
        )
      ).resolves.toBeUndefined()

      invoke.mockResolvedValueOnce(undefined)
      await expect(
        Steps.consensus.runRejectProducerRegistration(
          ctx,
          {
            kind: "ConsensusSteps.ProducerRegistrationInput",
            label: producer.label
          },
          signal
        )
      ).rejects.toThrow(/Missing expected rejection/)
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

    it("regfinkey delegates the write to Steps.contracts.sysio.system.runRegfinkey", async () => {
      const ctx = fixtureContext(),
        [producer] = seedProducerOperators(ctx),
        delegate = jest
          .spyOn(Steps.contracts.sysio.system, "runRegfinkey")
          .mockResolvedValue(undefined)
      await Steps.consensus.runRegisterFinalizerKey(
        ctx,
        { kind: "ConsensusSteps.ProducerRegistrationInput", label: producer.label },
        signal
      )
      expect(delegate).toHaveBeenCalledWith(
        ctx,
        {
          kind: "SystemContractSteps.RegfinkeyInput",
          data: {
            finalizer_name: producer.account,
            finalizer_key: producer.wireFinalizer.publicKey,
            proof_of_possession: producer.wireFinalizer.proofOfPossession
          }
        },
        signal
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

    it("every runner fails loudly for a producer that was never provisioned", async () => {
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
      await expect(
        Steps.consensus.runRejectProducerRegistration(ctx, input, signal)
      ).rejects.toThrow(/has not been provisioned/)
    })
  })
})
