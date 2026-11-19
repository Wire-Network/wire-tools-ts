import { ethers } from "ethers"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey, PublicKey, SysioContracts } from "@wireio/sdk-core"
import { KMSClientProvider } from "@wireio/cluster-tool/config/KMSClientProvider"
import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import {
  ethereumKeyPairFromKmsPublicKey,
  solanaKeyPairFromKmsPublicKey,
  solanaKeypair,
  wireKeyPairFromKmsPublicKey
} from "@wireio/cluster-tool/utils"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuild,
  ClusterBuildPhase,
  Steps,
  type ClusterBuildContext,
  type ClusterBuildParent,
  type ClusterBuildPhaseBase,
  type ClusterBuildPhaseGroup,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import type { KeyPair, SolanaSigner } from "@wireio/cluster-tool/types"
import {
  AWSAccountName,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureProducerTopologyOverrides } from "../../config/clusterConfigFixture.js"
import { fixtureExternalOutposts } from "../../config/resolveEnvironmentFixture.js"
import { fixtureOperatorAccount } from "../../orchestration/outputs/operatorAccountFixture.js"

/** A minimal parent that captures pushed children (no context needed for structure). */
function fakeParent<C extends ClusterBuildContext = ClusterBuildContext>(): ClusterBuildParent<C> {
  const parent: ClusterBuildParent<C> = {
    context: {} as C,
    push(..._children: ClusterBuildPhaseBase<C>[]) {
      return parent
    }
  }
  return parent
}

/** The `input.kind` of every step in a group's first phase. */
function firstPhaseStepKinds(group: ClusterBuildPhaseGroup): string[] {
  const phase = group.children[0] as ClusterBuildPhase
  return phase.steps.map(step => (step.input as StepInput)?.kind ?? "")
}

describe("WireOperatorProvisioningTool.planOperatorAccountProvisioning", () => {
  it("returns a parallel PhaseGroup with one Phase per operator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "Create ops", "provision ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, isBootstrapped: true },
      { label: "uwritaaaaaa", type: OperatorType.UNDERWRITER, isBootstrapped: false }
    ])
    expect(group.config.parallel).toBe(true)
    expect(group.children.length).toBe(2)
    expect(group.children.map(child => child.name)).toEqual([
      "Provision batchopaaaa",
      "Provision uwritaaaaaa"
    ])
  })

  it("a producer Phase creates the account only — its identity is materialized earlier", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "Producers", "producers", {}, [
      {
        label: "defproducera",
        type: OperatorType.PRODUCER,
        producerNodeIndex: 0
      }
    ])
    const kinds = firstPhaseStepKinds(group)
    // Materialization moved to `planProducerIdentityPhase`, which the bootstrap registers before
    // any node starts: a producing node renders one `--signature-provider` per hosted account at
    // launch, and the account's finalizer key has to exist by then. The account CREATION is a
    // chain write that cannot run until `sysio.system` is deployed, which is much later.
    expect(kinds).toEqual(["WireOperatorProvisioningTool.CreateAccountInput"])
    const phase = group.children[0] as ClusterBuildPhase
    expect(phase.steps.map(step => step.actor)).toEqual([Report.Actor.Producer])
  })

  it("a bootstrap batch/uw Phase (no funding) creates the account, authex-links both chains, registers", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "ops", "ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, isBootstrapped: true }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.CreateAccountInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.RegistrationInput"
    ])
  })

  it("a batch/uw Phase whose identity was materialized earlier plans NO materialization step", () => {
    // The bootstrap's `OperatorKeys` phase materialized it long before — ahead of the
    // Ethereum outpost deploy, which seats the operator's random address in the roster.
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "ops", "ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, identityMaterialized: true, isBootstrapped: true }
    ])
    expect(firstPhaseStepKinds(group)).toEqual([
      "WireOperatorProvisioningTool.CreateAccountInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.RegistrationInput"
    ])
  })

  it("a flow op WITH funding includes fund + airdrop steps", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "flow", "flow", {}, [
      {
        label: "depositoraaa",
        type: OperatorType.BATCH,
        isBootstrapped: false,
        fundEthereumWei: 10n ** 18n,
        airdropSolanaLamports: 5_000_000_000n
      }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
  })
})

/** The operator's durable handle — the keystore key and its on-chain account. */
const OperatorHandle = "batchopaaaa"

/**
 * A REAL {@link ClusterBuildContext} holding one materialized batch operator,
 * with the two chain writes its provisioning performs doubled at their seams.
 *
 * Every double is a `jest.spyOn` against the real member it replaces, so the
 * doubled signatures are the shipped ones — a client or key-store change breaks
 * this fixture instead of sliding past a hand-built stand-in. `getSysioContract`
 * mints a fresh Proxy (and a fresh invoker cache) per call, so the client spied
 * here is ALSO pinned as its return value.
 */
function fakeOperatorContext() {
  const ctx = fixtureContext(),
    { keyStore } = ctx
  keyStore.setOperator({
    label: OperatorHandle,
    publicationLabel: OperatorHandle,
    account: OperatorHandle,
    type: OperatorType.BATCH,
    wire: { type: KeyType.K1, publicKey: "PUB_K1_op", privateKey: "PVT_K1_op" }
  })

  const opreg = ctx.wire.getSysioContract(
      SysioContracts.SysioContractName.opreg
    ),
    createAccount = jest
      .spyOn(ctx.wire, "createAccount")
      .mockResolvedValue(undefined),
    regoperatorInvoke = jest
      .spyOn(opreg.actions.regoperator, "invoke")
      .mockResolvedValue(undefined)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(opreg as never)
  return { ctx, keyStore, createAccount, regoperatorInvoke }
}

describe("WireOperatorProvisioningTool.runAccountCreation", () => {
  /** The step input every account-creation test drives the runner with. */
  const CreateInput = {
    kind: "WireOperatorProvisioningTool.CreateAccountInput" as const,
    label: OperatorHandle
  }

  afterEach(() => jest.restoreAllMocks())

  it("creates the operator's account as sysio, owned by its own wire key", async () => {
    const { ctx, createAccount } = fakeOperatorContext()
    await WireOperatorProvisioningTool.runAccountCreation(
      ctx,
      CreateInput,
      new AbortController().signal
    )
    expect(createAccount).toHaveBeenCalledTimes(1)
    expect(createAccount).toHaveBeenCalledWith(
      "sysio",
      OperatorHandle,
      "PUB_K1_op",
      "PUB_K1_op"
    )
  })

  it("propagates a failed newaccount", async () => {
    const { ctx, createAccount } = fakeOperatorContext()
    createAccount.mockRejectedValueOnce(new Error("account_name_exists_exception"))
    await expect(
      WireOperatorProvisioningTool.runAccountCreation(
        ctx,
        CreateInput,
        new AbortController().signal
      )
    ).rejects.toThrow(/account_name_exists_exception/)
  })

  it("refuses an operator that was never materialized", async () => {
    const { ctx, createAccount } = fakeOperatorContext()
    await expect(
      WireOperatorProvisioningTool.runAccountCreation(
        ctx,
        { ...CreateInput, label: "missingop" },
        new AbortController().signal
      )
    ).rejects.toThrow(/missingop/)
    expect(createAccount).not.toHaveBeenCalled()
  })
})

describe("WireOperatorProvisioningTool.runRegistration", () => {
  afterEach(() => jest.restoreAllMocks())

  it("registers the operator's account on sysio.opreg", async () => {
    const { ctx, regoperatorInvoke } = fakeOperatorContext()
    await WireOperatorProvisioningTool.runRegistration(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.RegistrationInput",
        label: OperatorHandle,
        type: OperatorType.BATCH,
        isBootstrapped: true
      },
      new AbortController().signal
    )
    expect(regoperatorInvoke).toHaveBeenCalledTimes(1)
    // `account:` is the GENERATED ABI field on `opreg::regoperator` — it never
    // renames with the harness, and it carries the on-chain account.
    const [data] = regoperatorInvoke.mock.calls[0]
    expect(data.account).toBe(OperatorHandle)
    expect(data.is_bootstrapped).toBe(true)
    expect(data.type).toBe(SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH)
  })
})

describe("planOperatorAccountProvisioning — outpost-chain funding gate (H3)", () => {
  const FundedSpec = {
    label: "depositoraaa",
    type: OperatorType.BATCH,
    isBootstrapped: false,
    fundEthereumWei: 10n ** 18n,
    airdropSolanaLamports: 5_000_000_000n
  }

  /** Provision a funded batch op over a REAL context (the gate reads config). */
  function fundedKinds(externalOutposts?: ExternalOutpostConfig): string[] {
    const cluster = ClusterBuild.forContext(
      fixtureContext(externalOutposts != null ? { externalOutposts } : {})
    )
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ops",
      "ops",
      {},
      [FundedSpec]
    )
    return firstPhaseStepKinds(group)
  }

  it("INCLUDES fund + airdrop in local mode", () => {
    const kinds = fundedKinds()
    expect(kinds).toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
  })

  it("GATES OUT fund + airdrop in external-outpost mode (depot-side steps stay)", () => {
    const kinds = fundedKinds(fixtureExternalOutposts())
    expect(kinds).not.toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).not.toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
    // every depot-side step still runs.
    expect(kinds).toContain("WireOperatorProvisioningTool.CreateAccountInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.RegistrationInput")
  })
})

describe("WireOperatorProvisioningTool.planProducerIdentityPhase", () => {
  it("materializes ONE genesis producer identity per spec — producer-actor steps named for the label", () => {
    const phase = WireOperatorProvisioningTool.planProducerIdentityPhase(
      fakeParent(),
      "ProducerIdentities",
      "materialize genesis producer identities",
      {},
      [
        {
          label: "defproducera",
          type: OperatorType.PRODUCER,
          producerNodeIndex: 0,
          publicationLabel: "node_00"
        },
        {
          label: "defproducerb",
          type: OperatorType.PRODUCER,
          producerNodeIndex: 1,
          publicationLabel: "defproducerb"
        }
      ]
    )
    expect(phase.steps.map(step => step.name)).toEqual([
      "defproducera-identity",
      "defproducerb-identity"
    ])
    expect(phase.steps.map(step => step.actor)).toEqual([
      Report.Actor.Producer,
      Report.Actor.Producer
    ])
    expect(
      phase.steps.map(
        step => step.input as WireOperatorProvisioningTool.MaterializeProducerInput
      )
    ).toEqual([
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        label: "defproducera",
        producerNodeIndex: 0,
        publicationLabel: "node_00"
      },
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        label: "defproducerb",
        producerNodeIndex: 1,
        publicationLabel: "defproducerb"
      }
    ])
    // The Report names where each identity's keys publish.
    expect(phase.steps.map(step => step.description)).toEqual([
      "materialize producer defproducera identity from node 0 (keys published under node_00)",
      "materialize producer defproducerb identity from node 1 (keys published under defproducerb)"
    ])
  })

  it("refuses a spec that carries no publicationLabel — it is decided at plan time from the topology", () => {
    expect(() =>
      WireOperatorProvisioningTool.planProducerIdentityPhase(
        fakeParent(),
        "ProducerIdentities",
        "materialize",
        {},
        [{ label: "defproducera", type: OperatorType.PRODUCER, producerNodeIndex: 0 }]
      )
    ).toThrow(/publicationLabel is required/)
  })

  it("refuses a spec that names no hosting node — a genesis identity shares that node's K1", () => {
    expect(() =>
      WireOperatorProvisioningTool.planProducerIdentityPhase(
        fakeParent(),
        "ProducerIdentities",
        "materialize",
        {},
        [{ label: "flowprod", type: OperatorType.PRODUCER }]
      )
    ).toThrow(/producerNodeIndex is required/)
  })
})

/**
 * A COLLATERAL-BACKED producer: a PRODUCER spec with no `producerNodeIndex`. It takes the same
 * route every other bonded operator does — unique keys, an account of its own, authex
 * links on both chains, `opreg::regoperator` — and its identity step additionally mints the
 * finalizer key a producer needs to hold a rank position at all.
 */
describe("WireOperatorProvisioningTool — a collateral-backed PRODUCER (no producerNodeIndex)", () => {
  const signal = new AbortController().signal

  it("takes the OPP-operator route: unique identity, its own account, authex links, regoperator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "flow",
      "flow",
      {},
      [
        {
          label: "flowprod",
          type: OperatorType.PRODUCER,
          isBootstrapped: false
        }
      ]
    )
    expect(firstPhaseStepKinds(group)).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.CreateAccountInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.RegistrationInput"
    ])
    const phase = group.children[0] as ClusterBuildPhase
    expect(
      (phase.steps[0].input as WireOperatorProvisioningTool.MaterializeIdentityInput).type
    ).toBe(OperatorType.PRODUCER)
  })

  it("attributes every step of the route to the Producer actor, not the batch operator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "flow",
      "flow",
      {},
      [{ label: "flowprod", type: OperatorType.PRODUCER, isBootstrapped: false }]
    )
    const phase = group.children[0] as ClusterBuildPhase
    expect(new Set(phase.steps.map(step => step.actor))).toEqual(
      new Set([Report.Actor.Producer])
    )
  })

  it("registers a collateral-backed producer as NON-bootstrapped when the spec does not say", () => {
    // A bootstrapped registration would be ACTIVE at once and refused every deposit after — the
    // opposite of what the collateral route exists to exercise.
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "flow",
      "flow",
      {},
      [{ label: "flowprod", type: OperatorType.PRODUCER }]
    )
    const phase = group.children[0] as ClusterBuildPhase,
      registration = phase.steps
        .map(step => step.input as WireOperatorProvisioningTool.RegistrationInput)
        .find(input => input.kind === "WireOperatorProvisioningTool.RegistrationInput")
    expect(registration.isBootstrapped).toBe(false)
  })

  describe("runIdentityMaterialization", () => {
    /** A readable pair per curve — the adopt-or-create seam is doubled, so no generator runs. */
    function fakePair(keyType: KeyType, label: string): KeyPair<KeyType> {
      return {
        type: keyType,
        publicKey: `PUB_${KeyType[keyType]}_${label}`,
        privateKey: `PVT_${KeyType[keyType]}_${label}`,
        ...(keyType === KeyType.BLS ? { proofOfPossession: `SIG_${label}` } : {}),
        ...(keyType === KeyType.EM ? { address: `0x${label}` } : {})
      } as KeyPair<KeyType>
    }

    /** The ONE region a KMS key lives in, and the alias the harness renders for the first batch operator's K1. */
    const KmsRegion = "us-east-1",
      BootstrapWireAlias = "alias/wire/test/batchop-a/K1"

    /** A KMS-custodied K1 pair whose public identity is a fresh random key's — no material. */
    function wireKmsPair(alias = BootstrapWireAlias) {
      return wireKeyPairFromKmsPublicKey(
        PrivateKey.generate(KeyType.K1).toPublic().data.array,
        KmsRegion,
        alias
      )
    }

    /** The signer the KMS arm hands back — DERIVED from the provider's own return type. */
    type KmsWireSigner = Awaited<ReturnType<typeof KMSClientProvider.createWireSigner>>

    /** A sdk-core signer double for `wire`, with `KMSClientProvider.createWireSigner` doubled to hand it back. */
    function kmsSignerFor(wire: ReturnType<typeof wireKmsPair>) {
      const kmsSigner = {
          pubKey: PublicKey.from(wire.publicKey),
          sign: jest.fn()
        } as unknown as KmsWireSigner,
        createWireSigner = jest
          .spyOn(KMSClientProvider, "createWireSigner")
          .mockResolvedValue(kmsSigner)
      return { kmsSigner, createWireSigner }
    }

    /** A context whose key generation, wallet import and external-signer registration are doubled at their seams. */
    function materializationContext() {
      const ctx = fixtureContext(),
        addPrivateKey = jest.fn().mockResolvedValue(undefined),
        adopt = jest
          .spyOn(Steps.keys, "adoptOrCreateSignatureProviderKey")
          .mockImplementation(
            (async (_config: unknown, keyType: KeyType, account: string) =>
              fakePair(keyType, account)) as never
          ),
        addSigner = jest.spyOn(ctx.wire, "addSigner").mockImplementation(() => undefined)
      jest
        .spyOn(ctx.wire.wallet, "getOrCreate")
        .mockResolvedValue({ addPrivateKey } as never)
      return { ctx, adopt, addPrivateKey, addSigner }
    }

    afterEach(() => jest.restoreAllMocks())

    it("mints a PRODUCER its own finalizer key alongside the WIRE / ETH / SOL identity, and imports both wire keys", async () => {
      const { ctx, adopt, addPrivateKey } = materializationContext()
      await WireOperatorProvisioningTool.runIdentityMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label: "flowprod",
          type: OperatorType.PRODUCER
        },
        signal
      )
      const requested = adopt.mock.calls.map(([, keyType]) => keyType)
      expect(requested).toHaveLength(4)
      expect(requested).toEqual(
        expect.arrayContaining([KeyType.K1, KeyType.ED, KeyType.EM, KeyType.BLS])
      )
      const stored = ctx.keyStore.assertOperator("flowprod")
      expect(stored.type).toBe(OperatorType.PRODUCER)
      expect(stored.wire.publicKey).toBe("PUB_K1_flowprod")
      expect(stored.wireFinalizer.publicKey).toBe("PUB_BLS_flowprod")
      // `sysio` creates the account under the handle itself.
      expect(stored.account).toBe("flowprod")
      // Both the controller key and the finalizer key reach the wallet, so a KIOD node can vote.
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_K1_flowprod")
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_BLS_flowprod")
    })

    it("mints NO finalizer key for a batch operator — it has no finality role", async () => {
      const { ctx, adopt, addPrivateKey, addSigner } = materializationContext()
      await WireOperatorProvisioningTool.runIdentityMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label: "batchopaaaa",
          type: OperatorType.BATCH
        },
        signal
      )
      const requested = adopt.mock.calls.map(([, keyType]) => keyType)
      expect(requested).toHaveLength(3)
      expect(requested).not.toContain(KeyType.BLS)
      expect(ctx.keyStore.assertOperator("batchopaaaa").wireFinalizer).toBeUndefined()
      expect(ctx.keyStore.assertOperator("batchopaaaa").account).toBe("batchopaaaa")
      expect(addPrivateKey).toHaveBeenCalledTimes(1)
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_K1_batchopaaaa")
      // A wire key WITH material goes into kiod, never to the external-signer registry.
      expect(addSigner).not.toHaveBeenCalled()
    })

    it("registers a freshly ADOPTED KMS-custodied wire key as an EXTERNAL signer instead of importing it — the adopt seam hands back a material-less K1", async () => {
      const { ctx, adopt, addPrivateKey, addSigner } = materializationContext(),
        label = Constants.batchOperatorLabel(1),
        wire = wireKmsPair("alias/wire/test/batchop-b/K1"),
        { kmsSigner, createWireSigner } = kmsSignerFor(wire)
      adopt.mockImplementation(
        (async (_config: unknown, keyType: KeyType, account: string) =>
          keyType === KeyType.K1 ? wire : fakePair(keyType, account)) as never
      )
      await WireOperatorProvisioningTool.runIdentityMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label,
          type: OperatorType.BATCH
        },
        signal
      )
      expect(ctx.keyStore.assertOperator(label).wire).toBe(wire)
      // The KMS arm of `wireSigner`: region + alias + the pinned K1 public key, off the pair.
      expect(createWireSigner).toHaveBeenCalledTimes(1)
      const [region, keyId, publicKey] = createWireSigner.mock.calls[0]
      expect(region).toBe(KmsRegion)
      expect(keyId).toBe("alias/wire/test/batchop-b/K1")
      expect(publicKey.equals(wire.publicKey)).toBe(true)
      // Registered for the ACCOUNT the pushes act as; kiod never sees a key that has no material.
      expect(addSigner).toHaveBeenCalledTimes(1)
      expect(addSigner).toHaveBeenCalledWith(label, kmsSigner)
      expect(addPrivateKey).not.toHaveBeenCalled()
    })

    it("rejects a handle longer than 12 chars — it is the operator's WIRE account name", async () => {
      const { ctx } = materializationContext()
      await expect(
        WireOperatorProvisioningTool.runIdentityMaterialization(
          ctx,
          {
            kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
            label: "thirteenchars",
            type: OperatorType.PRODUCER
          },
          signal
        )
      ).rejects.toThrow(/must be a valid WIRE name/)
    })

    it("rejects a handle outside the WIRE name alphabet before any key is generated", async () => {
      const { ctx, adopt } = materializationContext()
      await expect(
        WireOperatorProvisioningTool.runIdentityMaterialization(
          ctx,
          {
            kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
            label: "Batch_Op9",
            type: OperatorType.BATCH
          },
          signal
        )
      ).rejects.toThrow(/must be a valid WIRE name/)
      expect(adopt).not.toHaveBeenCalled()
    })

    describe("a HELD identity (the key store already holds the label)", () => {
      /** The materialization input for `label` as `type`. */
      function input(
        label: string,
        type: OperatorType
      ): WireOperatorProvisioningTool.MaterializeIdentityInput {
        return {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label,
          type
        }
      }

      it("adopts it WHOLE: no key is generated, its wire key is imported, the store keeps it, and the adoption is noted", async () => {
        const { ctx, adopt, addPrivateKey } = materializationContext(),
          held = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH, "batchopaaaa"),
          recorder = new StepExtraRecorder()
        ctx.keyStore.setOperator(held)
        await StepExtraRecorder.runWith(recorder, () =>
          WireOperatorProvisioningTool.runIdentityMaterialization(
            ctx,
            input("batchopaaaa", OperatorType.BATCH),
            signal
          )
        )
        expect(adopt).not.toHaveBeenCalled()
        expect(addPrivateKey).toHaveBeenCalledTimes(1)
        expect(addPrivateKey).toHaveBeenCalledWith(held.wire.privateKey)
        expect(ctx.keyStore.assertOperator("batchopaaaa")).toBe(held)
        expect(recorder.calls).toEqual([
          {
            client: "harness",
            kind: "note",
            text: "adopted the identity batchopaaaa the context already held",
            label: "batchopaaaa",
            wire: held.wire.publicKey,
            ethereum: held.ethereum.address,
            solana: held.solana.publicKey
          }
        ])
      })

      it("registers a held identity's KMS-custodied wire key as an EXTERNAL signer — kiod never sees it, and the store keeps the pair as held", async () => {
        const { ctx, adopt, addPrivateKey, addSigner } = materializationContext(),
          label = Constants.batchOperatorLabel(0),
          wire = wireKmsPair(),
          held = { ...fixtureOperatorAccount(label, OperatorType.BATCH, label), wire },
          { kmsSigner, createWireSigner } = kmsSignerFor(wire)
        ctx.keyStore.setOperator(held)
        await WireOperatorProvisioningTool.runIdentityMaterialization(
          ctx,
          input(label, OperatorType.BATCH),
          signal
        )
        expect(adopt).not.toHaveBeenCalled()
        expect(createWireSigner).toHaveBeenCalledTimes(1)
        expect(createWireSigner.mock.calls[0][0]).toBe(KmsRegion)
        expect(createWireSigner.mock.calls[0][1]).toBe(BootstrapWireAlias)
        expect(addSigner).toHaveBeenCalledTimes(1)
        expect(addSigner).toHaveBeenCalledWith(label, kmsSigner)
        expect(addPrivateKey).not.toHaveBeenCalled()
        expect(ctx.keyStore.assertOperator(label)).toBe(held)
      })

      it("imports a held PRODUCER's finalizer key alongside its wire key", async () => {
        const { ctx, adopt, addPrivateKey } = materializationContext(),
          held = {
            ...fixtureOperatorAccount("flowprod", OperatorType.PRODUCER, "flowprod"),
            wireFinalizer: fakePair(KeyType.BLS, "flowprod") as KeyPair<KeyType.BLS>
          }
        ctx.keyStore.setOperator(held)
        await WireOperatorProvisioningTool.runIdentityMaterialization(
          ctx,
          input("flowprod", OperatorType.PRODUCER),
          signal
        )
        expect(adopt).not.toHaveBeenCalled()
        expect(addPrivateKey).toHaveBeenCalledTimes(2)
        expect(addPrivateKey).toHaveBeenCalledWith(held.wire.privateKey)
        expect(addPrivateKey).toHaveBeenCalledWith("PVT_BLS_flowprod")
      })

      it("refuses a held identity of another TYPE", async () => {
        const { ctx, adopt, addPrivateKey } = materializationContext()
        ctx.keyStore.setOperator(
          fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH, "batchopaaaa")
        )
        await expect(
          WireOperatorProvisioningTool.runIdentityMaterialization(
            ctx,
            input("batchopaaaa", OperatorType.PRODUCER),
            signal
          )
        ).rejects.toThrow(
          new RegExp(
            `batchopaaaa is held as a ${OperatorType[OperatorType.BATCH]}, not a ${OperatorType[OperatorType.PRODUCER]}`
          )
        )
        expect(adopt).not.toHaveBeenCalled()
        expect(addPrivateKey).not.toHaveBeenCalled()
      })

      it("refuses a held identity carrying no outpost keys", async () => {
        const { ctx, addPrivateKey } = materializationContext()
        ctx.keyStore.setOperator({
          label: "batchopaaaa",
          publicationLabel: "batchopaaaa",
          account: "batchopaaaa",
          type: OperatorType.BATCH,
          wire: fakePair(KeyType.K1, "batchopaaaa") as KeyPair<KeyType.K1>
        })
        await expect(
          WireOperatorProvisioningTool.runIdentityMaterialization(
            ctx,
            input("batchopaaaa", OperatorType.BATCH),
            signal
          )
        ).rejects.toThrow(/the held identity batchopaaaa carries no outpost keys/)
        expect(addPrivateKey).not.toHaveBeenCalled()
      })

      it("refuses a held PRODUCER without a finalizer key", async () => {
        const { ctx, addPrivateKey } = materializationContext()
        ctx.keyStore.setOperator(
          fixtureOperatorAccount("flowprod", OperatorType.PRODUCER, "flowprod")
        )
        await expect(
          WireOperatorProvisioningTool.runIdentityMaterialization(
            ctx,
            input("flowprod", OperatorType.PRODUCER),
            signal
          )
        ).rejects.toThrow(
          /the held producer identity flowprod carries no finalizer key/
        )
        expect(addPrivateKey).not.toHaveBeenCalled()
      })
    })
  })
})

/**
 * A GENESIS producer's identity, from its hosting node's key set. A node's SOLE producer IS the
 * node's identity — the node's K1 and BLS, published under the node's name, nothing generated or
 * re-imported. Siblings on a SHARED node keep the node's K1 but each get a finalizer key minted
 * for the account, because `regfinkey` enforces a global uniqueness check.
 */
describe("WireOperatorProvisioningTool.runProducerMaterialization", () => {
  const signal = new AbortController().signal,
    NodeIndex = 0,
    NodeKeys = {
      index: NodeIndex,
      keys: {
        wire: { type: KeyType.K1 as const, publicKey: "PUB_K1_n0", privateKey: "PVT_K1_n0" },
        wireFinalizer: {
          type: KeyType.BLS as const,
          publicKey: "PUB_BLS_n0",
          privateKey: "PVT_BLS_n0",
          proofOfPossession: "SIG_BLS_n0"
        }
      }
    }

  /**
   * A context over a `producerCount`-producer topology on ONE node, holding that node's key set,
   * with the adopt-or-create seam and the wallet doubled.
   */
  function materializationContext(producerCount: number) {
    const ctx = fixtureContext(fixtureProducerTopologyOverrides(1, producerCount)),
      addPrivateKey = jest.fn().mockResolvedValue(undefined),
      adopt = jest
        .spyOn(Steps.keys, "adoptOrCreateSignatureProviderKey")
        .mockImplementation(
          (async (_config: unknown, keyType: KeyType, account: string) => ({
            type: keyType,
            publicKey: `PUB_${KeyType[keyType]}_${account}`,
            privateKey: `PVT_${KeyType[keyType]}_${account}`,
            proofOfPossession: `SIG_${account}`
          })) as never
        )
    jest.spyOn(ctx.wire.wallet, "getOrCreate").mockResolvedValue({ addPrivateKey } as never)
    ctx.keyStore.pushNodes(NodeKeys)
    return { ctx, adopt, addPrivateKey }
  }

  /** The materialization input for `label` on the fixture node, publishing under `publicationLabel`. */
  function materializeInput(
    label: string,
    publicationLabel: string
  ): WireOperatorProvisioningTool.MaterializeProducerInput {
    return {
      kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
      label,
      producerNodeIndex: NodeIndex,
      publicationLabel
    }
  }

  afterEach(() => jest.restoreAllMocks())

  it("a node's SOLE producer takes the node's K1 AND BLS, publishes under the node's name, and generates + imports nothing", async () => {
    const { ctx, adopt, addPrivateKey } = materializationContext(1)
    await WireOperatorProvisioningTool.runProducerMaterialization(
      ctx,
      materializeInput("defproducera", "node_00"),
      signal
    )
    const stored = ctx.keyStore.assertOperator("defproducera")
    expect(stored.type).toBe(OperatorType.PRODUCER)
    // `sysio` creates the account under the handle itself.
    expect(stored.account).toBe("defproducera")
    expect(stored.publicationLabel).toBe("node_00")
    expect(stored.wire).toEqual(NodeKeys.keys.wire)
    expect(stored.wireFinalizer).toEqual(NodeKeys.keys.wireFinalizer)
    // No finalizer key is minted, and nothing is re-imported: the wallet step already holds both
    // node keys, and kiod rejects a re-import with `key_exist_exception`.
    expect(adopt).not.toHaveBeenCalled()
    expect(addPrivateKey).not.toHaveBeenCalled()
  })

  it("on a SHARED node takes the node's K1, mints the account's OWN finalizer key, and stores the account under its own handle", async () => {
    const { ctx, adopt, addPrivateKey } = materializationContext(2)
    await WireOperatorProvisioningTool.runProducerMaterialization(
      ctx,
      materializeInput("defproducera", "defproducera"),
      signal
    )
    // Exactly one key is generated, and it is the BLS finalizer key for THIS account.
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(adopt.mock.calls[0][1]).toBe(KeyType.BLS)
    expect(adopt.mock.calls[0][2]).toBe("defproducera")

    const stored = ctx.keyStore.assertOperator("defproducera")
    expect(stored.account).toBe("defproducera")
    expect(stored.publicationLabel).toBe("defproducera")
    expect(stored.wire).toEqual(NodeKeys.keys.wire)
    expect(stored.wireFinalizer.publicKey).toBe("PUB_BLS_defproducera")
    expect(stored.wireFinalizer.publicKey).not.toBe(NodeKeys.keys.wireFinalizer.publicKey)
    // The minted finalizer key reaches the wallet so a KIOD node can vote with it; the node's K1
    // is already there from the wallet step.
    expect(addPrivateKey).toHaveBeenCalledTimes(1)
    expect(addPrivateKey).toHaveBeenCalledWith("PVT_BLS_defproducera")
  })

  it("gives sibling producers on one node the SAME K1 and DIFFERENT finalizer keys", async () => {
    const { ctx } = materializationContext(2)
    for (const label of ["defproducera", "defproducerb"]) {
      await WireOperatorProvisioningTool.runProducerMaterialization(
        ctx,
        materializeInput(label, label),
        signal
      )
    }
    const a = ctx.keyStore.assertOperator("defproducera"),
      b = ctx.keyStore.assertOperator("defproducerb")
    expect(a.wire.publicKey).toBe(b.wire.publicKey)
    expect(a.wireFinalizer.publicKey).not.toBe(b.wireFinalizer.publicKey)
  })

  it.each([
    ["a sole producer carrying its own label", 1, "defproducera"],
    ["a shared-node producer carrying the node's name", 2, "node_00"]
  ] as const)(
    "refuses %s — the input drifted from the topology",
    async (_name, producerCount, publicationLabel) => {
      const { ctx, adopt } = materializationContext(producerCount)
      await expect(
        WireOperatorProvisioningTool.runProducerMaterialization(
          ctx,
          materializeInput("defproducera", publicationLabel),
          signal
        )
      ).rejects.toThrow(/does not match node node_00's topology/)
      expect(adopt).not.toHaveBeenCalled()
      expect(ctx.keyStore.operator("defproducera")).toBeUndefined()
    }
  )

  it("fails loudly for a node index the topology never planned", async () => {
    const { ctx, adopt } = materializationContext(1)
    await expect(
      WireOperatorProvisioningTool.runProducerMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
          label: "defproducerz",
          producerNodeIndex: 7,
          publicationLabel: "defproducerz"
        },
        signal
      )
    ).rejects.toThrow(/no planned producer node at index 7/)
    expect(adopt).not.toHaveBeenCalled()
  })

  it("fails loudly for a planned node whose keys the key store never generated", async () => {
    const ctx = fixtureContext(fixtureProducerTopologyOverrides(1, 1)),
      adopt = jest.spyOn(Steps.keys, "adoptOrCreateSignatureProviderKey")
    await expect(
      WireOperatorProvisioningTool.runProducerMaterialization(
        ctx,
        materializeInput("defproducera", "node_00"),
        signal
      )
    ).rejects.toThrow(/no generated keys for producer node 0/)
    expect(adopt).not.toHaveBeenCalled()
    expect(ctx.keyStore.operator("defproducera")).toBeUndefined()
  })
})

describe("planOperatorAccountProvisioning — SSM key publication for a FLOW operator", () => {
  /** Every key replicates to EVERY region — no primary. */
  const SSMRegions = ["us-east-1", "eu-west-1"]
  /** A flow's collateral depositor: a label no config enumeration knows. */
  const FlowBatchSpec = {
    label: "depositoraaa",
    type: OperatorType.BATCH,
    ethereumHdIndex: 35,
    isBootstrapped: false
  }

  /** An SSM context: `{cluster}` renders the AWS ACCOUNT, keys replicate to both regions. */
  function ssmContext(): ClusterBuildContext {
    return fixtureContext({
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegions: SSMRegions,
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        },
        kms: null,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.test,
        regions: SSMRegions,
        ssm: null,
        kms: null
      }
    })
  }

  /** The steps of the ONE phase `spec` plans over `ctx` (the SSM gate reads its config). */
  function phaseSteps(
    ctx: ClusterBuildContext,
    spec: WireOperatorProvisioningTool.OperatorProvisioningSpec
  ) {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      ClusterBuild.forContext(ctx),
      "ops",
      "ops",
      {},
      [spec]
    )
    return (group.children[0] as ClusterBuildPhase).steps
  }

  /** The publish inputs among `steps`, in plan order. */
  function publicationInputs(steps: ReturnType<typeof phaseSteps>) {
    return steps
      .map(step => step.input as StepInput)
      .filter(input => input.kind === "KeySteps.PublishSignatureProviderKeyInput")
      .map(input => input as Steps.keys.PublishSignatureProviderKeyInput)
  }

  it("publishes a flow batch operator's K1/EM/ED right after materialization, under its own handle", () => {
    const steps = phaseSteps(ssmContext(), FlowBatchSpec)
    expect(steps.map(step => (step.input as StepInput).kind)).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "KeySteps.PublishSignatureProviderKeyInput",
      "KeySteps.PublishSignatureProviderKeyInput",
      "KeySteps.PublishSignatureProviderKeyInput",
      "WireOperatorProvisioningTool.CreateAccountInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.RegistrationInput"
    ])
    const publications = publicationInputs(steps)
    expect(publications.map(publication => publication.secretId)).toEqual([
      "/wire/test/depositoraaa/K1",
      "/wire/test/depositoraaa/EM",
      "/wire/test/depositoraaa/ED"
    ])
    publications.forEach(publication => {
      expect(publication.label).toBe("depositoraaa")
      expect(publication.awsRegions).toEqual(SSMRegions)
    })
    // Named for the label like the phase's other steps, under the phase's actor.
    expect(steps[1].name).toBe("depositoraaa-publish-K1")
    expect(steps[1].actor).toBe(Report.Actor.BatchOperator)
  })

  it("adds the BLS finalizer key for a collateral-backed PRODUCER", () => {
    const publications = publicationInputs(
      phaseSteps(ssmContext(), {
        label: "produceraaaa",
        type: OperatorType.PRODUCER
      })
    )
    expect(publications.map(publication => KeyType[publication.keyType])).toEqual([
      "K1",
      "EM",
      "ED",
      "BLS"
    ])
  })

  it("publishes NOTHING for a bootstrapped batch operator — the bootstrap's operator publish phase owns its rows", () => {
    expect(
      publicationInputs(
        phaseSteps(ssmContext(), {
          label: Constants.batchOperatorLabel(0),
          type: OperatorType.BATCH,
          isBootstrapped: true
        })
      )
    ).toEqual([])
  })

  it("publishes NOTHING under a KEY signature provider", () => {
    expect(publicationInputs(phaseSteps(fixtureContext(), FlowBatchSpec))).toEqual(
      []
    )
  })
})

describe("WireOperatorProvisioningTool.runAuthexLink", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("signs the EVM link with a provider-less wallet, so it runs under an external-outpost config", async () => {
    // The context REFUSES its outpost clients in external-outpost mode — the
    // link must never reach for one.
    const ctx = fixtureContext({ externalOutposts: fixtureExternalOutposts() }),
      operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH),
      createLink = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined)
    ctx.keyStore.setOperator(operator)

    await WireOperatorProvisioningTool.runAuthexLink(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.AuthexLinkInput",
        label: operator.label,
        chainKind: ChainKind.EVM
      },
      new AbortController().signal
    )

    expect(createLink).toHaveBeenCalledTimes(1)
    // The EVM arm of the link params: the STORED public key plus a signer for it.
    const params = createLink.mock.calls[0][1] as AuthExLinkTool.EthereumLinkParams
    expect(params.chainKind).toBe(ChainKind.EVM)
    expect(params.account).toBe(operator.account)
    expect(params.publicKey).toBe(operator.ethereum.publicKey)
    expect(params.signer.provider).toBeNull()
    await expect(params.signer.getAddress()).resolves.toBe(
      operator.ethereum.address
    )
  })

  it("signs the EVM link THROUGH KMS when the operator's EM key lives there — the stored public key plus the KMS signer, offline", async () => {
    const ctx = fixtureContext(),
      wallet = ethers.Wallet.createRandom(),
      kmsRegion = "us-east-1",
      kmsAlias = "alias/wire/test/batchop-a/EM",
      kmsPair = ethereumKeyPairFromKmsPublicKey(
        ethers.getBytes(
          ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
        ),
        kmsRegion,
        kmsAlias
      ),
      operator = {
        ...fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH),
        ethereum: kmsPair
      },
      kmsSigner = new ethers.VoidSigner(wallet.address),
      createSigner = jest
        .spyOn(KMSClientProvider, "createSigner")
        .mockResolvedValue(kmsSigner),
      createLink = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined)
    ctx.keyStore.setOperator(operator)

    await WireOperatorProvisioningTool.runAuthexLink(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.AuthexLinkInput",
        label: operator.label,
        chainKind: ChainKind.EVM
      },
      new AbortController().signal
    )

    // The custody facade routed to KMS — region + alias off the pair, no provider (offline).
    expect(createSigner).toHaveBeenCalledTimes(1)
    expect(createSigner).toHaveBeenCalledWith(kmsRegion, kmsAlias, undefined)
    expect(createLink.mock.calls[0][1]).toEqual({
      chainKind: ChainKind.EVM,
      account: operator.account,
      publicKey: kmsPair.publicKey,
      signer: kmsSigner
    })
  })

  it("signs the SVM link through the custody facade — the STORED ED public key is linked, the signer derived from the pair", async () => {
    const ctx = fixtureContext(),
      operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH),
      createLink = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined)
    ctx.keyStore.setOperator(operator)
    await WireOperatorProvisioningTool.runAuthexLink(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.AuthexLinkInput",
        label: operator.label,
        chainKind: ChainKind.SVM
      },
      new AbortController().signal
    )
    const params = createLink.mock.calls[0][1] as AuthExLinkTool.SolanaLinkParams
    expect(params.chainKind).toBe(ChainKind.SVM)
    expect(params.account).toBe(operator.account)
    expect(params.publicKey).toBe(operator.solana.publicKey)
    // The signer IS the stored pair's: same point as the stored public key, and
    // it signs with the pair's material (no privateKey rides the params).
    expect(params.signer.publicKey.toBase58()).toBe(
      solanaKeypair(operator.solana).publicKey.toBase58()
    )
    expect(params).not.toHaveProperty("privateKey")
  })

  it("signs the SVM link through KMS when the stored ED pair is KMS-custodied — no material is ever read", async () => {
    const ctx = fixtureContext(),
      operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH),
      kmsPair = solanaKeyPairFromKmsPublicKey(
        solanaKeypair(operator.solana).publicKey.toBytes(),
        "us-east-1",
        "alias/wire/test/batchopaaaa/ED"
      ),
      kmsSigner = {
        publicKey: solanaKeypair(operator.solana).publicKey
      } as unknown as SolanaSigner,
      createSolanaSigner = jest
        .spyOn(KMSClientProvider, "createSolanaSigner")
        .mockResolvedValue(kmsSigner),
      createLink = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined)
    ctx.keyStore.setOperator({ ...operator, solana: kmsPair })
    await WireOperatorProvisioningTool.runAuthexLink(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.AuthexLinkInput",
        label: operator.label,
        chainKind: ChainKind.SVM
      },
      new AbortController().signal
    )
    expect(createSolanaSigner).toHaveBeenCalledWith(
      "us-east-1",
      "alias/wire/test/batchopaaaa/ED",
      solanaKeypair(operator.solana).publicKey.toBytes()
    )
    const params = createLink.mock.calls[0][1] as AuthExLinkTool.SolanaLinkParams
    expect(params.publicKey).toBe(kmsPair.publicKey)
    expect(params.signer).toBe(kmsSigner)
  })
})

describe("WireOperatorProvisioningTool.planOperatorIdentityPhase", () => {
  it("materializes ONE identity per spec, named for the label and attributed to the operator's actor", () => {
    const phase = WireOperatorProvisioningTool.planOperatorIdentityPhase(
      fakeParent(),
      "OperatorKeys",
      "materialize the batch operators",
      {},
      [
        { label: "batchopaaaa", type: OperatorType.BATCH },
        { label: "uwritaaaaaa", type: OperatorType.UNDERWRITER }
      ]
    )
    expect(phase.name).toBe("OperatorKeys")
    expect(phase.steps.map(step => step.name)).toEqual([
      "batchopaaaa-identity",
      "uwritaaaaaa-identity"
    ])
    expect(phase.steps.map(step => step.actor)).toEqual([
      Report.Actor.BatchOperator,
      Report.Actor.Underwriter
    ])
    expect(phase.steps.map(step => step.input)).toEqual([
      {
        kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
        label: "batchopaaaa",
        type: OperatorType.BATCH
      },
      {
        kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
        label: "uwritaaaaaa",
        type: OperatorType.UNDERWRITER
      }
    ])
    expect(phase.steps.map(step => step.runner)).toEqual([
      WireOperatorProvisioningTool.runIdentityMaterialization,
      WireOperatorProvisioningTool.runIdentityMaterialization
    ])
    expect(phase.steps.map(step => step.description)).toEqual([
      "generate batchopaaaa WIRE + ETH + SOL identity",
      "generate uwritaaaaaa WIRE + ETH + SOL identity"
    ])
  })

  it("plans the SAME materialization step a provisioning Phase would — which is why identityMaterialized can skip it", () => {
    const identity = WireOperatorProvisioningTool.planOperatorIdentityPhase(
        fakeParent(),
        "OperatorKeys",
        "materialize",
        {},
        [{ label: "batchopaaaa", type: OperatorType.BATCH }]
      ).steps[0],
      provisioning = (
        WireOperatorProvisioningTool.planOperatorAccountProvisioning(
          fakeParent(),
          "ops",
          "ops",
          {},
          [{ label: "batchopaaaa", type: OperatorType.BATCH, isBootstrapped: true }]
        ).children[0] as ClusterBuildPhase
      ).steps[0]
    expect(identity.name).toBe(provisioning.name)
    expect(identity.input).toEqual(provisioning.input)
    expect(identity.runner).toBe(provisioning.runner)
  })

  it("plans an EMPTY phase for no specs — a cluster with no batch operators still composes", () => {
    expect(
      WireOperatorProvisioningTool.planOperatorIdentityPhase(
        fakeParent(),
        "OperatorKeys",
        "materialize",
        {},
        []
      ).steps
    ).toEqual([])
  })
})

describe("WireOperatorProvisioningTool.planEthereumFunding / runEthereumFunding", () => {
  const signal = new AbortController().signal,
    FundWei = WireOperatorProvisioningTool.DefaultEthereumFundWei,
    /** The step input every funding test drives the runner with. */
    FundInput = {
      kind: "WireOperatorProvisioningTool.FundEthereumInput" as const,
      label: OperatorHandle,
      wei: FundWei
    }

  afterEach(() => jest.restoreAllMocks())

  /** A context holding one materialized batch operator (random EM key), its anvil faucet doubled. */
  function fundingContext() {
    const ctx = fixtureContext(),
      operator = fixtureOperatorAccount(OperatorHandle, OperatorType.BATCH),
      setBalance = jest
        .spyOn(ctx.ethereum, "setBalance")
        .mockResolvedValue(undefined)
    ctx.keyStore.setOperator(operator)
    return { ctx, operator, setBalance }
  }

  it("plans a typed step carrying the label and wei, with its named runner", () => {
    const step = WireOperatorProvisioningTool.planEthereumFunding(
      Report.Actor.BatchOperator,
      `${OperatorHandle}-fund-ethereum`,
      `fund ${OperatorHandle} ETH wallet`,
      {},
      OperatorHandle,
      FundWei
    )
    expect(step.actor).toBe(Report.Actor.BatchOperator)
    expect(step.input).toEqual(FundInput)
    expect(step.runner).toBe(WireOperatorProvisioningTool.runEthereumFunding)
  })

  it("sets the operator's RANDOM wallet balance through exactly one anvil_setBalance", async () => {
    const { ctx, operator, setBalance } = fundingContext()
    await WireOperatorProvisioningTool.runEthereumFunding(ctx, FundInput, signal)
    expect(setBalance).toHaveBeenCalledTimes(1)
    expect(setBalance).toHaveBeenCalledWith(operator.ethereum.address, FundWei)
  })

  it("refuses an operator that carries no Ethereum key", async () => {
    const { ctx, operator, setBalance } = fundingContext()
    ctx.keyStore.setOperator({ ...operator, ethereum: undefined })
    await expect(
      WireOperatorProvisioningTool.runEthereumFunding(ctx, FundInput, signal)
    ).rejects.toThrow(/has no Ethereum key/)
    expect(setBalance).not.toHaveBeenCalled()
  })

  it("refuses a label that was never materialized, and an aborted signal, before touching the faucet", async () => {
    const { ctx, setBalance } = fundingContext()
    await expect(
      WireOperatorProvisioningTool.runEthereumFunding(
        ctx,
        { ...FundInput, label: "missingop" },
        signal
      )
    ).rejects.toThrow(/missingop/)
    await expect(
      WireOperatorProvisioningTool.runEthereumFunding(
        ctx,
        FundInput,
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(setBalance).not.toHaveBeenCalled()
  })
})
