import { identity } from "lodash"
import { API, KeyType, PrivateKey, PublicKey } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { NodeOwnerTier } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { WireAuthorityAuditTool } from "@wireio/cluster-tool/tools/wire"
import { AccountObjectFixture } from "../../fixtures/AccountObjectFixture.js"
import { NewAccountTraceFixture } from "../../fixtures/NewAccountTraceFixture.js"

const { Classification, AuditPhase } = WireAuthorityAuditTool
const { account, permission, link } = AccountObjectFixture

/** The bootstrap key, in the legacy spelling the harness constants carry. */
const BootstrapKey = Constants.DEV_K1_PUBLIC_KEY
/** The same key as the chain reports it. */
const BootstrapKeyOnChain = PublicKey.from(BootstrapKey).toString()
/** A random K1 public key: an account's own key, none of them the bootstrap key. */
const randomPublicKey = (): string => PrivateKey.generate(KeyType.K1).toPublic().toString()
/** A producer's own key. */
const ProducerKey = randomPublicKey()
/** The tier-1 roster: the flow-controlled owners alone, as the bootstrap registers none. */
const Roster = ["gova", "govb", "govc"]
/** A hypothetical tier-1 owner whose account holds the bootstrap key. */
const KeySharingOwner = "keysharer"
/** The stand-in council a written `sysio.cncl@active` holds. */
const Council = ["cnla", "cnlb", "cnlc", "cnld"]

/** An account governed by `sysio@active`, its owner optionally granting its own code. */
function governed(name: string, ownCode = false): API.v1.AccountObject {
  return account(name, [
    permission("owner", "", 1, [], ["sysio@active", ...(ownCode ? [`${name}@sysio.code`] : [])]),
    permission("active", "owner", 1, [], ["sysio@active"])
  ])
}

/** An account keyed by `key` on both native permissions. */
function keyed(name: string, key: string): API.v1.AccountObject {
  return account(name, [
    permission("owner", "", 1, [key], []),
    permission("active", "owner", 1, [key], [])
  ])
}

/** A governance authority whose `active` is `members` at `threshold`. */
function authority(name: string, threshold: number, members: string[]): API.v1.AccountObject {
  return account(name, [
    permission("owner", "", 1, [], ["sysio@active"]),
    permission("active", "owner", threshold, [], members)
  ])
}

/** A chain before the handoff: sysio keyed, the system accounts governed, the documented exceptions in place. */
function preHandoffChain(): Map<string, API.v1.AccountObject> {
  return new Map<string, API.v1.AccountObject>([
    ["sysio", keyed("sysio", BootstrapKeyOnChain)],
    ["sysio.epoch", governed("sysio.epoch", true)],
    ["sysio.msgch", governed("sysio.msgch", true)],
    ["sysio.roa", governed("sysio.roa")],
    [
      "sysio.andon",
      account("sysio.andon", [
        ...governed("sysio.andon").permissions,
        permission("pull", "active", 1, [], ["andon.panic@active", "sysio@active"], [
          link("sysio.andon", "pull")
        ]),
        permission("clear", "active", 1, [], ["andon.panic@active", "sysio@active"], [
          link("sysio.andon", "clear")
        ])
      ])
    ],
    ["sysio.nodes", authority("sysio.nodes", 3, Roster.map(owner => `${owner}@active`))],
    ["sysio.cncl", authority("sysio.cncl", 1, ["sysio.null@active"])],
    [
      "sysio.null",
      account("sysio.null", [permission("owner", "", 1, [], []), permission("active", "owner", 1, [], [])])
    ],
    [
      "sysio.prods",
      account("sysio.prods", [
        permission("owner", "", 1, [], []),
        permission("active", "owner", 1, [], ["defproducera@active"]),
        permission("prod.major", "active", 1, [], ["defproducera@active"])
      ])
    ],
    ["andon.panic", keyed("andon.panic", BootstrapKeyOnChain)],
    ["defproducera", keyed("defproducera", ProducerKey)],
    ...Roster.map(
      (owner): [string, API.v1.AccountObject] => [
        owner,
        keyed(owner, randomPublicKey())
      ]
    ),
    ...Council.map(
      (member): [string, API.v1.AccountObject] => [
        member,
        keyed(member, randomPublicKey())
      ]
    )
  ])
}

/** The same chain after `sysio` was handed to `sysio.nodes`. */
function postHandoffChain(): Map<string, API.v1.AccountObject> {
  const chain = preHandoffChain()
  chain.set(
    "sysio",
    account("sysio", [
      permission("owner", "", 1, [], ["sysio.nodes@active"]),
      permission("active", "owner", 1, [], ["sysio.nodes@active"])
    ])
  )
  return chain
}

/** A WIRE client whose `get_account` answers from `chain` and whose `sysio.roa` tier-1 roster is `roster`. */
function wireFor(chain: Map<string, API.v1.AccountObject>, roster: string[] = Roster): WireClient {
  const roastate = { query: jest.fn().mockResolvedValue({ rows: [{ network_gen: 0 }], more: false }) },
    nodeowners = {
      queryAll: jest.fn().mockResolvedValue(roster.map(owner => ({ owner, tier: NodeOwnerTier.T1 })))
    }
  return {
    api: {
      v1: {
        chain: {
          get_account: jest.fn(async (name: string) => {
            const response = chain.get(name)
            if (response == null) throw new Error(`unknown account ${name}`)
            return response
          })
        }
      }
    },
    getSysioContract: jest.fn(() => ({ tables: { roastate, nodeowners } }))
  } as never
}

/** The audited system accounts of the fake chain. */
const Audited = [
  "sysio",
  "sysio.andon",
  "sysio.cncl",
  "sysio.epoch",
  "sysio.msgch",
  "sysio.nodes",
  "sysio.null",
  "sysio.prods",
  "sysio.roa"
]

/** The audit options of one phase. */
function optionsFor(
  phase: WireAuthorityAuditTool.AuditPhase,
  overrides: Partial<WireAuthorityAuditTool.AuditOptions> = {}
): WireAuthorityAuditTool.AuditOptions {
  return {
    accounts: Audited,
    panicAccount: Constants.PANIC_ACCOUNT,
    keys: [BootstrapKey],
    phase,
    ...(phase === AuditPhase.afterHandoff ? { handedTo: Constants.NODE_OWNERS_AUTHORITY } : {}),
    ...overrides
  }
}

/** Audit `chain` before the handoff. */
function auditBefore(chain: Map<string, API.v1.AccountObject>, roster: string[] = Roster) {
  return WireAuthorityAuditTool.audit(wireFor(chain, roster), optionsFor(AuditPhase.beforeHandoff))
}

/** Audit `chain` after the handoff to `sysio.nodes`. */
function auditAfter(
  chain: Map<string, API.v1.AccountObject>,
  overrides: Partial<WireAuthorityAuditTool.AuditOptions> = {}
) {
  return WireAuthorityAuditTool.audit(wireFor(chain), optionsFor(AuditPhase.afterHandoff, overrides))
}

/** `account@permission<-subject` for every finding of one classification. */
function spelled(entries: WireAuthorityAuditTool.AuditedEntry[]): string[] {
  return entries.map(entry => `${entry.account}@${entry.permission}<-${entry.subject}`).sort()
}

/** `chain` with `name` replaced. */
function withAccount(
  chain: Map<string, API.v1.AccountObject>,
  replacement: API.v1.AccountObject
): Map<string, API.v1.AccountObject> {
  chain.set(String(replacement.account_name), replacement)
  return chain
}

describe("WireAuthorityAuditTool.audit", () => {
  it("classifies every documented exception before a handoff and passes", async () => {
    const result = await auditBefore(preHandoffChain())
    expect(result.unclassified).toEqual([])
    expect(result.mismatches).toEqual([])
    expect(result.unexpectedLinks).toEqual([])
    expect(() => WireAuthorityAuditTool.assertClean(result)).not.toThrow()
    const kinds = (classification: WireAuthorityAuditTool.Classification) =>
      spelled(result.exceptions.filter(entry => entry.classification === classification))
    expect(kinds(Classification.rootKey)).toEqual(
      [`sysio@active<-${BootstrapKeyOnChain}`, `sysio@owner<-${BootstrapKeyOnChain}`].sort()
    )
    expect(kinds(Classification.ownContractCode)).toEqual([
      "sysio.epoch@owner<-sysio.epoch@sysio.code",
      "sysio.msgch@owner<-sysio.msgch@sysio.code"
    ])
    expect(kinds(Classification.andonPanicDelegate)).toEqual([
      "sysio.andon@clear<-andon.panic@active",
      "sysio.andon@pull<-andon.panic@active"
    ])
    expect(kinds(Classification.unsatisfiablePlaceholder)).toEqual([
      "sysio.cncl@active<-sysio.null@active"
    ])
    expect(kinds(Classification.governanceAuthorityMember)).toEqual(
      Roster.map(owner => `sysio.nodes@active<-${owner}@active`).sort()
    )
    expect(kinds(Classification.producerAuthority)).toEqual([
      "sysio.prods@active<-defproducera@active",
      "sysio.prods@prod.major<-defproducera@active"
    ])
    // The panic exception names the key the panic account holds.
    expect(
      result.exceptions.find(entry => entry.classification === Classification.andonPanicDelegate)
        .reason
    ).toContain(BootstrapKeyOnChain)
  })

  it("finds that the bootstrap key alone satisfies everything sysio governs before the handoff", async () => {
    const result = await auditBefore(preHandoffChain()),
      satisfied = result.keyReach
        .filter(reach => reach.satisfies)
        .map(reach => `${reach.account}@${reach.permission}`)
    expect(satisfied).toEqual(
      expect.arrayContaining(["sysio@active", "sysio.epoch@owner", "sysio.andon@pull"])
    )
    expect(satisfied).not.toContain("sysio.nodes@active")
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, BootstrapKey)).toThrow(
      /still satisfies .*sysio@owner/
    )
  })

  it("after the handoff the key alone satisfies only the andon panic permissions", async () => {
    const result = await auditAfter(postHandoffChain())
    expect(() => WireAuthorityAuditTool.assertClean(result)).not.toThrow()
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, BootstrapKey)).not.toThrow()
    expect(
      result.keyReach
        .filter(reach => reach.satisfies)
        .map(reach => `${reach.account}@${reach.permission}`)
        .sort()
    ).toEqual(["sysio.andon@clear", "sysio.andon@pull"])
    // No tier-1 owner holds the key, so it carries no weight on sysio.nodes@active.
    expect(
      result.keyReach.find(reach => reach.account === "sysio.nodes" && reach.permission === "active")
    ).toBeUndefined()
    expect(
      spelled(
        result.exceptions.filter(entry => entry.classification === Classification.governanceAuthority)
      )
    ).toEqual(["sysio@active<-sysio.nodes@active", "sysio@owner<-sysio.nodes@active"])
  })

  it("counts a tier-1 owner holding the key as one vote on sysio.nodes@active, short of its threshold", async () => {
    const roster = [...Roster, KeySharingOwner],
      chain = withAccount(
        withAccount(postHandoffChain(), keyed(KeySharingOwner, BootstrapKeyOnChain)),
        authority("sysio.nodes", 3, roster.map(owner => `${owner}@active`))
      ),
      result = await WireAuthorityAuditTool.audit(
        wireFor(chain, roster),
        optionsFor(AuditPhase.afterHandoff)
      )
    expect(() => WireAuthorityAuditTool.assertClean(result)).not.toThrow()
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, BootstrapKey)).not.toThrow()
    expect(
      result.keyReach.find(reach => reach.account === "sysio.nodes" && reach.permission === "active")
    ).toMatchObject({ weight: 1, threshold: 3, satisfies: false })
    // sysio delegates to sysio.nodes@active alone, so that one vote reaches no further.
    expect(
      result.keyReach
        .filter(reach => reach.satisfies)
        .map(reach => `${reach.account}@${reach.permission}`)
        .sort()
    ).toEqual(["sysio.andon@clear", "sysio.andon@pull"])
  })

  it("refuses an after-handoff audit that names no authority", async () => {
    await expect(
      WireAuthorityAuditTool.audit(
        wireFor(postHandoffChain()),
        optionsFor(AuditPhase.afterHandoff, { handedTo: undefined })
      )
    ).rejects.toThrow(/must name the authority sysio was handed to/)
  })

  describe("keys", () => {
    it("fails on a key held by any other system permission", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account("sysio.epoch", [
            permission("owner", "", 1, [], ["sysio@active"]),
            permission("active", "owner", 1, [BootstrapKeyOnChain], ["sysio@active"])
          ])
        )
      )
      expect(result.unclassified).toHaveLength(1)
      expect(result.unclassified[0]).toMatchObject({
        account: "sysio.epoch",
        permission: "active",
        kind: WireAuthorityAuditTool.EntryKind.key
      })
      expect(() => WireAuthorityAuditTool.assertClean(result)).toThrow(
        /unclassified key .* on sysio\.epoch@active/
      )
    })

    it("fails on a key on a custom permission of sysio, even before the handoff", async () => {
      const chain = preHandoffChain()
      withAccount(
        chain,
        account("sysio", [
          ...chain.get("sysio").permissions,
          permission("ops", "active", 1, [BootstrapKeyOnChain], [])
        ])
      )
      const result = await auditBefore(chain)
      expect(spelled(result.unclassified)).toEqual([`sysio@ops<-${BootstrapKeyOnChain}`])
    })

    it("fails a mixed post-handoff sysio authority that keeps the bootstrap key beside the governance authority", async () => {
      const chain = postHandoffChain()
      withAccount(
        chain,
        account("sysio", [
          permission("owner", "", 2, [BootstrapKeyOnChain], ["sysio.nodes@active"]),
          permission("active", "owner", 1, [], ["sysio.nodes@active"])
        ])
      )
      const result = await auditAfter(chain)
      expect(spelled(result.unclassified)).toEqual([`sysio@owner<-${BootstrapKeyOnChain}`])
      expect(result.mismatches.map(mismatch => `${mismatch.account}@${mismatch.permission}`)).toEqual([
        "sysio@owner"
      ])
      expect(() => WireAuthorityAuditTool.assertClean(result)).toThrow(
        /authority of sysio@owner differs: after the handoff sysio@owner must delegate to sysio\.nodes@active alone/
      )
    })
  })

  describe("sysio@active delegations", () => {
    it("fails sysio delegating its own native permission to itself", async () => {
      const chain = preHandoffChain()
      withAccount(
        chain,
        account("sysio", [
          permission("owner", "", 1, [BootstrapKeyOnChain], []),
          permission("active", "owner", 1, [BootstrapKeyOnChain], ["sysio@active"])
        ])
      )
      expect(spelled((await auditBefore(chain)).unclassified)).toEqual(["sysio@active<-sysio@active"])
    })

    it("fails a governance authority's active delegating to sysio@active", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          authority("sysio.nodes", 3, [...Roster.map(owner => `${owner}@active`), "sysio@active"])
        )
      )
      expect(spelled(result.unclassified)).toEqual(["sysio.nodes@active<-sysio@active"])
    })

    it("fails on a delegation to an account outside the documented exceptions", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account("sysio.epoch", [
            permission("owner", "", 1, [], ["sysio@active"]),
            permission("active", "owner", 1, [], ["defproducera@active", "sysio@active"])
          ])
        )
      )
      expect(result.unclassified.map(entry => entry.subject)).toEqual(["defproducera@active"])
      expect(() => WireAuthorityAuditTool.assertClean(result)).toThrow(/defproducera@active/)
    })
  })

  describe("code grants", () => {
    it.each([
      [
        "an account the bootstrap grants no code",
        governed("sysio.roa", true),
        "sysio.roa@owner<-sysio.roa@sysio.code"
      ],
      [
        "an OPP account's own code on active rather than owner",
        account("sysio.epoch", [
          permission("owner", "", 1, [], ["sysio@active", "sysio.epoch@sysio.code"]),
          permission("active", "owner", 1, [], ["sysio@active", "sysio.epoch@sysio.code"])
        ]),
        "sysio.epoch@active<-sysio.epoch@sysio.code"
      ],
      [
        "another contract's code",
        account("sysio.roa", [
          permission("owner", "", 1, [], ["sysio@active"]),
          permission("active", "owner", 1, [], ["sysio@active", "sysio.msgch@sysio.code"])
        ]),
        "sysio.roa@active<-sysio.msgch@sysio.code"
      ]
    ])("fails %s", async (_case, replacement, finding) => {
      expect(spelled((await auditBefore(withAccount(preHandoffChain(), replacement))).unclassified)).toEqual([
        finding
      ])
    })

    it("lists exactly each OPP account's own code on its owner as a bootstrap grant", () => {
      expect(WireAuthorityAuditTool.BootstrapCodeGrants).toEqual(
        Constants.OPP_SYSTEM_ACCOUNTS.map(name => ({ account: name, permission: "owner", grantee: name }))
      )
    })
  })

  describe("the panic account", () => {
    it.each([
      [
        "a native permission of sysio.andon",
        account("sysio.andon", [
          permission("owner", "", 1, [], ["sysio@active"]),
          permission("active", "owner", 1, [], ["andon.panic@active", "sysio@active"])
        ]),
        "sysio.andon@active<-andon.panic@active"
      ],
      [
        "a sysio.andon permission the bootstrap does not create",
        account("sysio.andon", [
          ...governed("sysio.andon").permissions,
          permission("halt", "active", 1, [], ["andon.panic@active", "sysio@active"])
        ]),
        "sysio.andon@halt<-andon.panic@active"
      ],
      [
        "another account",
        account("sysio.epoch", [
          ...governed("sysio.epoch", true).permissions,
          permission("pull", "active", 1, [], ["andon.panic@active", "sysio@active"])
        ]),
        "sysio.epoch@pull<-andon.panic@active"
      ]
    ])("fails delegated from %s", async (_case, replacement, finding) => {
      const result = await auditBefore(withAccount(preHandoffChain(), replacement))
      expect(spelled(result.unclassified)).toEqual([finding])
    })
  })

  describe("governance authorities", () => {
    it("fails sysio delegating to a governance authority before the handoff", async () => {
      const chain = preHandoffChain()
      withAccount(
        chain,
        account("sysio", [
          permission("owner", "", 1, [BootstrapKeyOnChain], []),
          permission("active", "owner", 1, [BootstrapKeyOnChain], ["sysio.nodes@active"])
        ])
      )
      expect(spelled((await auditBefore(chain)).unclassified)).toEqual([
        "sysio@active<-sysio.nodes@active"
      ])
    })

    it("fails sysio delegating to a governance authority in a before-handoff audit, even one naming that authority", async () => {
      const result = await WireAuthorityAuditTool.audit(
        wireFor(postHandoffChain()),
        optionsFor(AuditPhase.beforeHandoff, { handedTo: Constants.NODE_OWNERS_AUTHORITY })
      )
      expect(spelled(result.unclassified)).toEqual([
        "sysio@active<-sysio.nodes@active",
        "sysio@owner<-sysio.nodes@active"
      ])
    })

    it("fails sysio.nodes@active delegated from an account other than sysio", async () => {
      const result = await auditAfter(
        withAccount(
          postHandoffChain(),
          account("sysio.epoch", [
            permission("owner", "", 1, [], ["sysio@active", "sysio.epoch@sysio.code"]),
            permission("active", "owner", 1, [], ["sysio.nodes@active"])
          ])
        )
      )
      expect(spelled(result.unclassified)).toEqual(["sysio.epoch@active<-sysio.nodes@active"])
    })

    it("fails sysio delegating to the authority it was NOT handed to", async () => {
      const result = await auditAfter(postHandoffChain(), { handedTo: Constants.COUNCIL_AUTHORITY })
      expect(spelled(result.unclassified)).toEqual([
        "sysio@active<-sysio.nodes@active",
        "sysio@owner<-sysio.nodes@active"
      ])
      // ...and sysio.cncl, the authority named, is still the placeholder.
      expect(result.mismatches.map(mismatch => `${mismatch.account}@${mismatch.permission}`).sort()).toEqual(
        ["sysio.cncl@active", "sysio@active", "sysio@owner"]
      )
    })

    it("fails a member of sysio.nodes@active who is not on the tier-1 roster, and the roster it lacks", async () => {
      const chain = withAccount(preHandoffChain(), keyed("intruder", ProducerKey)),
        result = await auditBefore(
          withAccount(
            chain,
            authority("sysio.nodes", 3, ["gova@active", "govb@active", "govc@active", "intruder@active"])
          )
        )
      expect(spelled(result.unclassified)).toEqual(["sysio.nodes@active<-intruder@active"])
      expect(result.mismatches).toHaveLength(1)
      expect(result.mismatches[0]).toMatchObject({
        account: "sysio.nodes",
        permission: "active",
        reason: "sysio.nodes@active must be [gova, govb, govc] at 3"
      })
    })

    it("fails sysio.nodes@active at a threshold other than the roster's supermajority", async () => {
      const result = await auditBefore(
        withAccount(preHandoffChain(), authority("sysio.nodes", 2, Roster.map(owner => `${owner}@active`)))
      )
      expect(result.unclassified).toEqual([])
      expect(result.mismatches.map(mismatch => mismatch.actual.threshold)).toEqual([2])
    })

    it("fails a governance member entry outside the authority's active", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account("sysio.nodes", [
            permission("owner", "", 1, [], ["gova@active", "sysio@active"]),
            permission("active", "owner", 3, [], Roster.map(owner => `${owner}@active`))
          ])
        )
      )
      expect(spelled(result.unclassified)).toEqual(["sysio.nodes@owner<-gova@active"])
    })

    it("checks a written sysio.cncl against the caller's council, and fails it when none is given", async () => {
      const chain = withAccount(
        postHandoffChain(),
        authority("sysio.cncl", 3, Council.map(member => `${member}@active`))
      )
      expect((await auditAfter(chain, { councilMembers: Council })).mismatches).toEqual([])
      const unnamed = await auditAfter(chain)
      expect(spelled(unnamed.unclassified)).toEqual(
        Council.map(member => `sysio.cncl@active<-${member}@active`).sort()
      )
      expect(unnamed.mismatches[0].reason).toMatch(/given no members it must hold/)
    })

    it("fails a handoff target still holding the placeholder", async () => {
      const chain = withAccount(postHandoffChain(), authority("sysio.nodes", 1, ["sysio.null@active"]))
      const result = await auditAfter(chain)
      expect(result.mismatches.map(mismatch => mismatch.reason)).toEqual([
        "sysio was handed to sysio.nodes, whose active is still the unwritten placeholder"
      ])
    })
  })

  describe("the sysio.null placeholder", () => {
    it.each([
      ["a non-governance account", governed("sysio.epoch", true), "sysio.epoch", "active"],
      [
        "a governance authority's owner",
        account("sysio.cncl", [
          permission("owner", "", 1, [], ["sysio.null@active"]),
          permission("active", "owner", 1, [], ["sysio.null@active"])
        ]),
        "sysio.cncl",
        "owner"
      ],
      [
        "a governance active that also names a member",
        authority("sysio.cncl", 1, ["cnla@active", "sysio.null@active"]),
        "sysio.cncl",
        "active"
      ]
    ])("fails sysio.null@active on %s", async (_case, base, name, target) => {
      const replacement =
        name === "sysio.epoch"
          ? account(name, [
              base.permissions[0],
              permission("active", "owner", 1, [], ["sysio.null@active"])
            ])
          : base
      const result = await WireAuthorityAuditTool.audit(
        wireFor(withAccount(preHandoffChain(), replacement)),
        optionsFor(AuditPhase.beforeHandoff, { councilMembers: ["cnla"] })
      )
      expect(spelled(result.unclassified)).toContain(`${name}@${target}<-sysio.null@active`)
    })
  })

  describe("action links", () => {
    it("fails on an unexpected action link, including one to sysio.any", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account(
            "sysio.epoch",
            [
              governed("sysio.epoch", true).permissions[0],
              permission("active", "owner", 1, [], ["sysio@active"], [link("sysio.token")])
            ],
            [link("sysio.epoch", "advance")]
          )
        )
      )
      expect(result.unexpectedLinks).toEqual([
        { account: "sysio.epoch", permission: "sysio.any", action: "sysio.epoch::advance" },
        { account: "sysio.epoch", permission: "active", action: "sysio.token::*" }
      ])
      expect(() => WireAuthorityAuditTool.assertClean(result)).toThrow(/unexpected link/)
    })

    it.each([
      ["the other panic action", link("sysio.andon", "clear"), "sysio.andon::clear"],
      ["every action of the contract", link("sysio.andon"), "sysio.andon::*"],
      ["another contract's action", link("sysio.epoch", "pull"), "sysio.epoch::pull"]
    ])("fails an andon panic permission linked to %s", async (_case, wrong, spelling) => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account("sysio.andon", [
            ...governed("sysio.andon").permissions,
            permission("pull", "active", 1, [], ["andon.panic@active", "sysio@active"], [wrong]),
            permission("clear", "active", 1, [], ["andon.panic@active", "sysio@active"], [
              link("sysio.andon", "clear")
            ])
          ])
        )
      )
      expect(result.unexpectedLinks).toEqual([
        { account: "sysio.andon", permission: "pull", action: spelling }
      ])
    })

    it("fails a sysio.andon permission the bootstrap does not create, linked to its own action", async () => {
      const result = await auditBefore(
        withAccount(
          preHandoffChain(),
          account("sysio.andon", [
            ...preHandoffChain().get("sysio.andon").permissions,
            permission("halt", "active", 1, [], ["sysio@active"], [link("sysio.andon", "halt")])
          ])
        )
      )
      expect(result.unexpectedLinks).toEqual([
        { account: "sysio.andon", permission: "halt", action: "sysio.andon::halt" }
      ])
    })
  })

  it("reports a listed account the chain never created", () => {
    expect(() =>
      WireAuthorityAuditTool.assertClean(
        {
          keys: [],
          permissions: [],
          exceptions: [],
          unclassified: [],
          mismatches: [],
          unexpectedLinks: [],
          keyReach: []
        },
        { accounts: [], unlisted: [], missing: ["sysio.cncl"] }
      )
    ).toThrow(/sysio\.cncl does not exist/)
  })

  it("describes each exception with its reason, and each reach", async () => {
    const lines = WireAuthorityAuditTool.describe(await auditAfter(postHandoffChain()), {
      accounts: Audited,
      unlisted: ["sysio.extra"],
      missing: []
    })
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^audited 9 accounts/),
        "unlisted system account sysio.extra (audited)",
        expect.stringMatching(/^exception andonPanicDelegate: sysio\.andon@pull <- andon\.panic@active/),
        expect.stringMatching(/SATISFIES sysio\.andon@pull/)
      ])
    )
  })
})

describe("WireAuthorityAuditTool.assertKeyRetired", () => {
  it("matches the key in any spelling against its normalized reach", async () => {
    const result = await auditBefore(preHandoffChain())
    expect(result.keys).toEqual([BootstrapKeyOnChain])
    result.keyReach.forEach(reach => expect(reach.key).toBe(BootstrapKeyOnChain))
    // The legacy and the PUB_K1 spelling find the same reach.
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, BootstrapKey)).toThrow(/still satisfies/)
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, BootstrapKeyOnChain)).toThrow(
      /still satisfies/
    )
  })

  it("refuses a key the audit never computed reach for", async () => {
    const result = await auditAfter(postHandoffChain())
    expect(() => WireAuthorityAuditTool.assertKeyRetired(result, ProducerKey)).toThrow(
      /was not audited/
    )
  })
})

describe("WireAuthorityAuditTool.normalizeKey", () => {
  it("spells a legacy key and its PUB_K1 form alike", () => {
    expect(WireAuthorityAuditTool.normalizeKey(BootstrapKey)).toBe(BootstrapKeyOnChain)
    expect(WireAuthorityAuditTool.normalizeKey(BootstrapKeyOnChain)).toBe(BootstrapKeyOnChain)
  })

  it("rejects text that is not a key", () => {
    expect(() => WireAuthorityAuditTool.normalizeKey("not-a-key")).toThrow()
  })
})

describe("WireAuthorityAuditTool.discoverSystemAccounts", () => {
  /** How a node serves the `sysio::newaccount` actions it traced. */
  type TracedCreation = typeof NewAccountTraceFixture.decoded

  /** A traced block of `actions`. */
  function tracedBlock(number: number, actions: WireClient.TraceAction[]): WireClient.GetBlockTraceResponse {
    return {
      number,
      status: WireClient.BlockTraceStatus.irreversible,
      transactions: [{ id: `trx${number}`, block_num: number, block_time: "2026-11-10T00:00:00.000", actions }]
    }
  }

  /** A traced block creating `names` through `sysio::newaccount`, each traced as `traced` shapes it. */
  function block(
    number: number,
    names: string[],
    traced: TracedCreation = NewAccountTraceFixture.decoded
  ): WireClient.GetBlockTraceResponse {
    return tracedBlock(
      number,
      names.flatMap(name => [
        traced(name),
        // A notification to another receiver is not a second creation.
        traced(name, "sysio.roa")
      ])
    )
  }

  /**
   * A WIRE client tracing `blocks` up to LIB `lib`, whose `get_raw_abi` answers
   * with the `newaccount` ABI.
   */
  function scanned(blocks: Map<number, WireClient.GetBlockTraceResponse>, lib: number) {
    const getBlockTrace = jest.fn(async (number: number) => blocks.get(number)),
      getRawAbi = jest.fn().mockResolvedValue({ abi: NewAccountTraceFixture.Abi }),
      wire = {
        api: { v1: { chain: { get_raw_abi: getRawAbi } } },
        getInfo: jest.fn().mockResolvedValue({ last_irreversible_block_num: lib }),
        getBlockTrace
      } as never
    return { wire, getBlockTrace, getRawAbi }
  }

  /** The system accounts block 3 creates in {@link scanned}'s history. */
  const LaterSystemAccounts = Constants.SYSTEM_ACCOUNTS.filter(
    name => name !== "sysio.cncl" && name !== "sysio.roa" && name !== "sysio.acct"
  )

  it("audits genesis, every sysio.* account created, and the listed ones that exist", async () => {
    const { wire, getBlockTrace, getRawAbi } = scanned(
        new Map([
          [2, block(2, ["sysio.roa", "sysio.acct"])],
          [3, block(3, ["defproducera", "sysio.extra", ...LaterSystemAccounts])],
          [4, block(4, [])]
        ]),
        4
      ),
      inventory = await WireAuthorityAuditTool.discoverSystemAccounts(
        wire,
        new AbortController().signal
      )
    expect(inventory.accounts).toEqual(expect.arrayContaining(["sysio", "sysio.null", "sysio.prods", "sysio.extra", "dev.owner1", "sysio.nodes"]))
    expect(inventory.accounts).not.toContain("defproducera")
    expect(inventory.accounts).not.toContain("sysio.cncl")
    expect(inventory.unlisted).toEqual(["sysio.extra"])
    expect(inventory.missing).toEqual(["sysio.cncl"])
    // The genesis block has no trace; the scan starts after it and reaches LIB.
    expect(getBlockTrace.mock.calls.map(([number]) => number)).toEqual([2, 3, 4])
    // Every creation carried decoded params, so no ABI was read.
    expect(getRawAbi).not.toHaveBeenCalled()
  })

  it("reads a creation the node did not decode from its encoded data, reading the sysio ABI once", async () => {
    const { wire, getRawAbi } = scanned(
        new Map([
          [2, block(2, ["sysio.roa", "sysio.acct"])],
          [3, block(3, ["defproducera", "sysio.extra", ...LaterSystemAccounts], NewAccountTraceFixture.raw)]
        ]),
        3
      ),
      inventory = await WireAuthorityAuditTool.discoverSystemAccounts(
        wire,
        new AbortController().signal
      )
    expect(inventory.accounts).toEqual(expect.arrayContaining(["sysio.roa", "sysio.acct", "sysio.extra", "dev.owner1", "sysio.nodes"]))
    expect(inventory.accounts).not.toContain("defproducera")
    expect(inventory.unlisted).toEqual(["sysio.extra"])
    expect(inventory.missing).toEqual(["sysio.cncl"])
    expect(getRawAbi).toHaveBeenCalledTimes(1)
    expect(String(getRawAbi.mock.calls[0][0])).toBe("sysio")
  })

  it("fails, naming the block, on a creation with neither params nor decodable data", async () => {
    const created = NewAccountTraceFixture.raw("sysio.extra"),
      { wire } = scanned(
        new Map([
          [2, block(2, ["sysio.roa"])],
          // The node did not decode it, and its data is one byte short.
          [3, tracedBlock(3, [{ ...created, data: created.data.slice(0, -2) }])]
        ]),
        3
      ),
      failure = await WireAuthorityAuditTool.discoverSystemAccounts(
        wire,
        new AbortController().signal
      ).then(() => null, identity<NestedError>)
    expect(failure).toBeInstanceOf(NestedError)
    expect(failure.message).toMatch(
      /^authority audit: block 3 traces a sysio::newaccount whose new account cannot be read; read the traces from a node that decodes them, or pass the accounts to audit explicitly/
    )
    expect(failure.message).toContain("transaction=trx3")
    expect(failure.causes).toHaveLength(1)
    expect(failure.causes[0].message).toContain("carries no decoded params, and its data does not decode with the sysio ABI")
  })

  it("fails, naming the block, on a creation without params when the sysio ABI cannot be read", async () => {
    const { wire, getRawAbi } = scanned(
      new Map([[2, block(2, ["sysio.roa"], NewAccountTraceFixture.raw)]]),
      2
    )
    getRawAbi.mockRejectedValue(new Error("get_raw_abi refused"))
    const failure = await WireAuthorityAuditTool.discoverSystemAccounts(
      wire,
      new AbortController().signal
    ).then(() => null, identity<NestedError>)
    expect(failure).toBeInstanceOf(NestedError)
    expect(failure.message).toMatch(/^authority audit: block 2 traces a sysio::newaccount whose new account cannot be read/)
    expect(failure.causes[0].message).toBe("get_raw_abi refused")
  })

  it("refuses to enumerate from a node that holds no trace of a block", async () => {
    const wire = {
      api: { v1: { chain: { get_raw_abi: jest.fn() } } },
      getInfo: jest.fn().mockResolvedValue({ last_irreversible_block_num: 3 }),
      getBlockTrace: jest.fn().mockResolvedValue(null)
    } as never
    await expect(
      WireAuthorityAuditTool.discoverSystemAccounts(wire, new AbortController().signal)
    ).rejects.toThrow(/holds no trace of block 2/)
  })

  it("names the creating action by its generated name", () => {
    expect(WireAuthorityAuditTool.NewAccountAction).toBe("newaccount")
  })
})
