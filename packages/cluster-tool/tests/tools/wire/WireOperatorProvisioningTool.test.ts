import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, Name, SysioContracts } from "@wireio/sdk-core"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import { Report } from "@wireio/cluster-tool/report"
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
import type { KeyPair } from "@wireio/cluster-tool/types"
import {
  AWSAccountName,
  SignatureProviderType,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

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
      { label: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true },
      { label: "uwritaaaaaa", type: OperatorType.UNDERWRITER, ethereumHdIndex: 2, isBootstrapped: false }
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

  it("a bootstrap batch/uw Phase (no funding) sponsors the account, authex-links both chains, registers", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "ops", "ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.SponsoredAccountCreationInput",
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
        ethereumHdIndex: 35,
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

/** A generated `wireno.<suffix>`-style chain account for the sponsored-creation tests. */
const GeneratedAccount = "wireno.x3f9k"
/** The operator's DURABLE handle — the keystore key, never the sponsor nonce. */
const OperatorHandle = "batchopaaaa"
/** A FOREIGN sponsors row's nonce — never the one this operator's `newuser` minted. */
const DecoyNonce = "zzzzzzzzzzzz"
/** The account the foreign row carries — adopting it means the nonce predicate never ran. */
const DecoyAccount = "wireno.decoy"

/**
 * A REAL {@link ClusterBuildContext} whose `sponsors` table behaves like the
 * depot: a row appears ONLY for a nonce that `newuser` was actually called
 * with, AHEAD of it a foreign operator's row (the roster is shared, scoped to
 * the node owner) so the read-back's nonce predicate is genuinely exercised — a
 * read that returned `rows[0]` would adopt {@link DecoyAccount}. `emitRow` off
 * makes every read miss, which is how the "no row after newuser" case is
 * exercised without contriving a nonce value.
 *
 * Every double is a `jest.spyOn` against the real member it replaces, so the
 * doubled signatures are the shipped ones — a contract-client or key-store
 * change breaks this fixture instead of sliding past a hand-built stand-in.
 * `getSysioContract` mints a fresh Proxy (and a fresh invoker cache) per call,
 * so the two clients spied here are ALSO pinned as its return values.
 */
function fakeSponsorContext(emitRow = true) {
  const nonces: string[] = [],
    ctx = fixtureContext(),
    { keyStore } = ctx
  keyStore.setOperator({
    label: OperatorHandle,
    publicationLabel: OperatorHandle,
    type: OperatorType.BATCH,
    wire: { type: KeyType.K1, publicKey: "PUB_K1_op", privateKey: "PVT_K1_op" }
  })

  const roa = ctx.wire.getSysioContract(SysioContracts.SysioContractName.roa),
    opreg = ctx.wire.getSysioContract(
      SysioContracts.SysioContractName.opreg
    ),
    newuserInvoke = jest
      .spyOn(roa.actions.newuser, "invoke")
      .mockImplementation(async data => {
        nonces.push(data.nonce)
        return undefined
      }),
    regoperatorInvoke = jest
      .spyOn(opreg.actions.regoperator, "invoke")
      .mockResolvedValue(undefined),
    sponsorsQuery = jest
      .spyOn(roa.tables.sponsors, "query")
      .mockImplementation(async args => ({
        scope: args.scope,
        rows: emitRow
          ? [
              { nonce: DecoyNonce, username: DecoyAccount },
              ...nonces.map(nonce => ({ nonce, username: GeneratedAccount }))
            ]
          : [],
        more: false
      }))
  jest
    .spyOn(ctx.wire, "getSysioContract")
    .mockImplementation(name =>
      name === SysioContracts.SysioContractName.roa ? roa : opreg
    )
  return { ctx, keyStore, nonces, newuserInvoke, regoperatorInvoke, sponsorsQuery }
}

/** The step input every sponsored-creation test drives the runner with. */
const SponsoredInput = {
  kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput" as const,
  label: OperatorHandle
}

describe("WireOperatorProvisioningTool.runSponsoredAccountCreation", () => {
  it("invokes roa::newuser as the node owner and adopts the generated name into account", async () => {
    const { ctx, keyStore, newuserInvoke } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      SponsoredInput,
      new AbortController().signal
    )
    expect(newuserInvoke).toHaveBeenCalledTimes(1)
    const [data, options] = newuserInvoke.mock.calls[0]
    expect(data.creator).toBe(Constants.BOOTSTRAP_NODE_OWNER)
    expect(data.pubkey).toBe("PUB_K1_op")
    expect(options).toEqual({
      authorization: [
        { actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }
      ]
    })
    const operator = keyStore.assertOperator(OperatorHandle)
    // The read-back lands on account; the durable handle is untouched.
    expect(operator.account).toBe(GeneratedAccount)
    expect(operator.label).toBe(OperatorHandle)
  })

  it("passes a FRESH single-use nonce — never the operator's durable handle", async () => {
    const { ctx, newuserInvoke } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      SponsoredInput,
      new AbortController().signal
    )
    const [{ nonce }] = newuserInvoke.mock.calls[0]
    expect(nonce).not.toBe(OperatorHandle)
    expect(nonce).toMatch(/^[a-z1-5]{12}$/)
    expect(Name.isValid(nonce)).toBe(true)
  })

  it("mints a DIFFERENT nonce on every run (no reuse across operators)", async () => {
    const first = fakeSponsorContext(),
      second = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      first.ctx,
      SponsoredInput,
      new AbortController().signal
    )
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      second.ctx,
      SponsoredInput,
      new AbortController().signal
    )
    expect(first.nonces[0]).not.toBe(second.nonces[0])
  })

  it("reads the sponsors table back BY THE MINTED NONCE, with an explicit row limit", async () => {
    const { ctx, keyStore, sponsorsQuery } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      SponsoredInput,
      new AbortController().signal
    )
    // ONE read — the pre-check is gone, so the only query is the read-back.
    expect(sponsorsQuery).toHaveBeenCalledTimes(1)
    const [args] = sponsorsQuery.mock.calls[0]
    expect(args.scope).toBe(Constants.BOOTSTRAP_NODE_OWNER)
    expect(args.limit).toBeGreaterThan(0)
    // The foreign row precedes this operator's in the returned page, so the
    // adopted account proves the NONCE selected the row — a read that took
    // `rows[0]` (or dropped the predicate) would have adopted the decoy.
    const operator = keyStore.assertOperator(OperatorHandle)
    expect(operator.account).toBe(GeneratedAccount)
    expect(operator.account).not.toBe(DecoyAccount)
  })

  it("propagates a failed sponsors read instead of treating it as 'no row yet'", async () => {
    const { ctx, sponsorsQuery } = fakeSponsorContext()
    sponsorsQuery.mockRejectedValueOnce(
      new Error("Contract Table Query Exception: Table sponsors is not specified in the ABI")
    )
    await expect(
      WireOperatorProvisioningTool.runSponsoredAccountCreation(
        ctx,
        SponsoredInput,
        new AbortController().signal
      )
    ).rejects.toThrow(/Contract Table Query Exception/)
  })

  it("throws when no sponsors row exists for the minted nonce after newuser", async () => {
    const { ctx } = fakeSponsorContext(false)
    await expect(
      WireOperatorProvisioningTool.runSponsoredAccountCreation(
        ctx,
        SponsoredInput,
        new AbortController().signal
      )
    ).rejects.toThrow(/no sponsors row for nonce/)
  })
})

describe("WireOperatorProvisioningTool.runRegistration", () => {
  it("registers the operator's RESOLVED account, not its durable handle", async () => {
    const { ctx, keyStore, regoperatorInvoke } = fakeSponsorContext()
    keyStore.setOperator({
      ...keyStore.assertOperator(OperatorHandle),
      account: GeneratedAccount
    })
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
    expect(data.account).toBe(GeneratedAccount)
    expect(data.account).not.toBe(OperatorHandle)
    expect(data.is_bootstrapped).toBe(true)
    expect(data.type).toBe(SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH)
  })
})

describe("planOperatorAccountProvisioning — outpost-chain funding gate (H3)", () => {
  const FundedSpec = {
    label: "depositoraaa",
    type: OperatorType.BATCH,
    ethereumHdIndex: 35,
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
    const kinds = fundedKinds({
      ethereum: { addressFile: "outpost-addrs.json", abiFiles: [], chainId: 1 },
      solana: { idlFile: "idl.json" }
    })
    expect(kinds).not.toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).not.toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
    // every depot-side step still runs.
    expect(kinds).toContain("WireOperatorProvisioningTool.SponsoredAccountCreationInput")
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
        { label: "defproducera", type: OperatorType.PRODUCER, producerNodeIndex: 0 },
        { label: "defproducerb", type: OperatorType.PRODUCER, producerNodeIndex: 1 }
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
        producerNodeIndex: 0
      },
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        label: "defproducerb",
        producerNodeIndex: 1
      }
    ])
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
 * route every other bonded operator does — unique keys, a node-owner-sponsored account, authex
 * links on both chains, `opreg::regoperator` — and its identity step additionally mints the
 * finalizer key a producer needs to hold a rank position at all.
 */
describe("WireOperatorProvisioningTool — a collateral-backed PRODUCER (no producerNodeIndex)", () => {
  const signal = new AbortController().signal

  it("takes the OPP-operator route: unique identity, sponsored account, authex links, regoperator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "flow",
      "flow",
      {},
      [
        {
          label: "flowprod",
          type: OperatorType.PRODUCER,
          ethereumHdIndex: 36,
          isBootstrapped: false
        }
      ]
    )
    expect(firstPhaseStepKinds(group)).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.SponsoredAccountCreationInput",
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
      [{ label: "flowprod", type: OperatorType.PRODUCER, ethereumHdIndex: 36, isBootstrapped: false }]
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
      [{ label: "flowprod", type: OperatorType.PRODUCER, ethereumHdIndex: 36 }]
    )
    const phase = group.children[0] as ClusterBuildPhase,
      registration = phase.steps
        .map(step => step.input as WireOperatorProvisioningTool.RegistrationInput)
        .find(input => input.kind === "WireOperatorProvisioningTool.RegistrationInput")
    expect(registration.isBootstrapped).toBe(false)
  })

  it("refuses a producer spec that names BOTH a hosting node and an ETH wallet index", () => {
    // The genesis route would win and silently drop the outpost identity, the links and the
    // registration.
    expect(() =>
      WireOperatorProvisioningTool.planOperatorAccountProvisioning(
        fakeParent(),
        "flow",
        "flow",
        {},
        [{ label: "flowprod", type: OperatorType.PRODUCER, producerNodeIndex: 0, ethereumHdIndex: 36 }]
      )
    ).toThrow(/mutually exclusive/)
  })

  it("refuses a collateral-backed producer with no ethereumHdIndex — it bonds on Ethereum like any operator", () => {
    expect(() =>
      WireOperatorProvisioningTool.planOperatorAccountProvisioning(
        fakeParent(),
        "flow",
        "flow",
        {},
        [{ label: "flowprod", type: OperatorType.PRODUCER, isBootstrapped: false }]
      )
    ).toThrow(/ethereumHdIndex is required/)
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

    /** A context whose key generation and wallet import are doubled at their seams. */
    function materializationContext() {
      const ctx = fixtureContext(),
        addPrivateKey = jest.fn().mockResolvedValue(undefined),
        adopt = jest
          .spyOn(Steps.keys, "adoptOrCreateSignatureProviderKey")
          .mockImplementation(
            (async (_config: unknown, keyType: KeyType, account: string) =>
              fakePair(keyType, account)) as never
          )
      jest
        .spyOn(ctx.wire.wallet, "getOrCreate")
        .mockResolvedValue({ addPrivateKey } as never)
      return { ctx, adopt, addPrivateKey }
    }

    afterEach(() => jest.restoreAllMocks())

    it("mints a PRODUCER its own finalizer key alongside the WIRE / ETH / SOL identity, and imports both wire keys", async () => {
      const { ctx, adopt, addPrivateKey } = materializationContext()
      await WireOperatorProvisioningTool.runIdentityMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label: "flowprod",
          type: OperatorType.PRODUCER,
          ethereumHdIndex: 36
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
      // `account` stays unset until the sponsored-creation step adopts the generated name.
      expect(stored.account).toBeUndefined()
      // Both the controller key and the finalizer key reach the wallet, so a KIOD node can vote.
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_K1_flowprod")
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_BLS_flowprod")
    })

    it("mints NO finalizer key for a batch operator — it has no finality role", async () => {
      const { ctx, adopt, addPrivateKey } = materializationContext()
      await WireOperatorProvisioningTool.runIdentityMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
          label: "batchopaaaa",
          type: OperatorType.BATCH,
          ethereumHdIndex: 1
        },
        signal
      )
      const requested = adopt.mock.calls.map(([, keyType]) => keyType)
      expect(requested).toHaveLength(3)
      expect(requested).not.toContain(KeyType.BLS)
      expect(ctx.keyStore.assertOperator("batchopaaaa").wireFinalizer).toBeUndefined()
      expect(addPrivateKey).toHaveBeenCalledTimes(1)
      expect(addPrivateKey).toHaveBeenCalledWith("PVT_K1_batchopaaaa")
    })

    it("rejects a handle longer than 12 chars — it is a node-directory and SSM path segment", async () => {
      const { ctx } = materializationContext()
      await expect(
        WireOperatorProvisioningTool.runIdentityMaterialization(
          ctx,
          {
            kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
            label: "thirteenchars",
            type: OperatorType.PRODUCER,
            ethereumHdIndex: 36
          },
          signal
        )
      ).rejects.toThrow(/must be 1\.\.12 chars/)
    })
  })
})

/**
 * A GENESIS producer's identity: the hosting node's K1 for block signing, plus a finalizer key
 * MINTED FOR THE ACCOUNT — never the node's, because `regfinkey` enforces a global uniqueness
 * check and siblings on one node would collide on the node's key.
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

  /** A context holding the node's key set, with the adopt-or-create seam and the wallet doubled. */
  function materializationContext() {
    const ctx = fixtureContext(),
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

  afterEach(() => jest.restoreAllMocks())

  it("takes the node's K1, mints the account's OWN finalizer key, and stores the account under its own handle", async () => {
    const { ctx, adopt, addPrivateKey } = materializationContext()
    await WireOperatorProvisioningTool.runProducerMaterialization(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        label: "defproducera",
        producerNodeIndex: NodeIndex
      },
      signal
    )
    // Exactly one key is generated, and it is the BLS finalizer key for THIS account.
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(adopt.mock.calls[0][1]).toBe(KeyType.BLS)
    expect(adopt.mock.calls[0][2]).toBe("defproducera")

    const stored = ctx.keyStore.assertOperator("defproducera")
    expect(stored.type).toBe(OperatorType.PRODUCER)
    // A producer never goes through roa::newuser: its on-chain name IS its handle.
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
    const { ctx } = materializationContext()
    for (const label of ["defproducera", "defproducerb"]) {
      await WireOperatorProvisioningTool.runProducerMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
          label,
          producerNodeIndex: NodeIndex
        },
        signal
      )
    }
    const a = ctx.keyStore.assertOperator("defproducera"),
      b = ctx.keyStore.assertOperator("defproducerb")
    expect(a.wire.publicKey).toBe(b.wire.publicKey)
    expect(a.wireFinalizer.publicKey).not.toBe(b.wireFinalizer.publicKey)
  })

  it("fails loudly for a node index the key store never generated", async () => {
    const { ctx, adopt } = materializationContext()
    await expect(
      WireOperatorProvisioningTool.runProducerMaterialization(
        ctx,
        {
          kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
          label: "defproducerz",
          producerNodeIndex: 7
        },
        signal
      )
    ).rejects.toThrow()
    expect(adopt).not.toHaveBeenCalled()
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
        }
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.test,
        regions: SSMRegions,
        ssm: null
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
      "WireOperatorProvisioningTool.SponsoredAccountCreationInput",
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
      expect(publication.source).toBe(Steps.keys.SignatureKeySource.operator)
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
        type: OperatorType.PRODUCER,
        ethereumHdIndex: 36
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
          ethereumHdIndex: 1,
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
