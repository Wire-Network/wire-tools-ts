import Assert from "node:assert"
import { chunk, isEqual, range, sortBy, uniq } from "lodash"
import { match, P } from "ts-pattern"
import { ABICache, type AbiProvider, API, PublicKey, SysioContracts } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { NodeOwnerTier } from "@wireio/opp-typescript-models"
import { WireClient } from "../../clients/wire/WireClient.js"
import { Constants } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { AndonContractSteps } from "../../orchestration/steps/contracts/sysio/AndonContractSteps.js"
import { BondContractSteps } from "../../orchestration/steps/contracts/sysio/BondContractSteps.js"
import { GovernanceSteps } from "../../orchestration/steps/GovernanceSteps.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { WireNodeOwnerTool } from "./WireNodeOwnerTool.js"
import { WireSysioContractTool } from "./WireSysioContractTool.js"

const log = getLogger(__filename)

const { SysioContractName, SysioContractAccount } = SysioContracts

/** The emergency-stop contract, whose pull and clear permissions delegate to the panic account. */
const AndonAccount = SysioContractAccount[SysioContractName.andon]
/** The underwriting contract, whose ruling permissions delegate to the judge account. */
const BondAccount = SysioContractAccount[SysioContractName.bond]
/** What an exception's reason calls the account the Andon permissions delegate to. */
const PanicRole = "panic"
/** What an exception's reason calls the account the bond rulings delegate to. */
const JudgeRole = "judge"

/**
 * The authority audit to run before (and after) handing `sysio` to a
 * governance authority. It reads EVERY permission of every audited account —
 * `owner`, `active` and each custom permission with its linked actions —
 * classifies every key and every account delegation as governance or as one of
 * the documented exceptions, compares each governance authority with the
 * members it must hold, and computes which permissions a given key (the
 * bootstrap `sysio` key) can satisfy on its own through the delegation graph.
 * A key or delegation it cannot classify, an authority that differs from the
 * one expected, or an action link it does not expect, fails the audit: a
 * retained key anywhere in the graph could bypass the handoff.
 *
 * Every call is a read; it never writes. {@link discoverSystemAccounts}
 * enumerates the accounts from the chain's own history, so the audit covers
 * every `sysio.*` account that exists, not only the ones the bootstrap names.
 */
export namespace WireAuthorityAuditTool {
  /** The prefix only `sysio` may create accounts under: the system namespace. */
  export const SystemAccountPrefix = "sysio."
  /** The accounts the chain creates at genesis, which no `newaccount` ever names. */
  export const GenesisAccounts = [
    Constants.SYSIO_ACCOUNT,
    Constants.NULL_ACCOUNT,
    Constants.PRODUCERS_ACCOUNT
  ] as const
  /** Block traces read at once while {@link discoverSystemAccounts} scans the history. */
  export const TraceScanConcurrency = 32
  /**
   * The first block a node traces: block 1 is the genesis block, built from
   * the genesis state rather than applied, so it carries no transaction and no
   * trace. The genesis accounts it holds are {@link GenesisAccounts}.
   */
  export const FirstTracedBlockNum = 2
  /** The action that creates an account, typed as its literal, which selects its generated data type. */
  export const NewAccountAction =
    "newaccount" satisfies WireClient.ActionName<SysioContracts.SysioContractName.system>
  /** The permission a `linkauth` to "any permission" targets. */
  export const AnyPermission = "sysio.any"
  /** How a contract-wide link (no action named) is spelled. */
  export const ContractWideAction = "*"

  /** What an authority entry names. */
  export enum EntryKind {
    key = "key",
    account = "account"
  }

  /** Whether `sysio` has been handed to a governance authority yet. */
  export enum AuditPhase {
    /** `sysio@owner` / `@active` still hold the bootstrap key. */
    beforeHandoff = "beforeHandoff",
    /** `sysio@owner` / `@active` must delegate to {@link AuditOptions.handedTo} alone, with no key. */
    afterHandoff = "afterHandoff"
  }

  /** Why an authority entry is allowed. */
  export enum Classification {
    /** Delegates to `sysio@active`: the account is governed by `sysio`. */
    governance = "governance",
    /** An account's own `@sysio.code` where the bootstrap grants it ({@link BootstrapCodeGrants}). */
    ownContractCode = "ownContractCode",
    /** Another contract's `@sysio.code` on exactly a pair the bootstrap grants ({@link BootstrapCodeGrants}). */
    crossContractCode = "crossContractCode",
    /** A `sysio.andon` panic permission delegating to the panic account. */
    andonPanicDelegate = "andonPanicDelegate",
    /** A `sysio.bond` ruling permission delegating to the judge account. */
    bondJudgeDelegate = "bondJudgeDelegate",
    /** `sysio`'s own key on `owner` / `active` BEFORE a handoff: the authority a handoff replaces. */
    rootKey = "rootKey",
    /** `sysio@owner` / `@active` delegating to the governance authority it was handed to. */
    governanceAuthority = "governanceAuthority",
    /** An expected member of a governance authority's `active`, written by `sysio.councl`. */
    governanceAuthorityMember = "governanceAuthorityMember",
    /** A governance authority's `active` placeholder, `sysio.null@active`, which nothing satisfies. */
    unsatisfiablePlaceholder = "unsatisfiablePlaceholder",
    /** A `sysio.prods` permission naming a scheduled producer; the chain keeps it equal to the schedule. */
    producerAuthority = "producerAuthority"
  }

  /**
   * The classifications of a permission delegated to a keyed account outside
   * `sysio.*`. Whoever holds that account's key satisfies the permission, a
   * handoff of `sysio` notwithstanding.
   */
  export const DelegateClassifications: ReadonlyArray<Classification> = [
    Classification.andonPanicDelegate,
    Classification.bondJudgeDelegate
  ]

  /** One `<grantee>@sysio.code` delegation on `<account>@<permission>`. */
  export interface CodeGrant {
    /** The account whose permission carries the grant. */
    readonly account: string
    /** The permission carrying it. */
    readonly permission: string
    /** The contract whose code the grant lets act for `account`. */
    readonly grantee: string
  }

  /**
   * Every `@sysio.code` grant the bootstrap creates: each OPP account's `owner`
   * names its own code (`grantSysioCode`). The bootstrap configures no
   * cross-contract grant, so any other code delegation is unclassified.
   */
  export const BootstrapCodeGrants: ReadonlyArray<CodeGrant> = Constants.OPP_SYSTEM_ACCOUNTS.map(
    account => ({ account, permission: WireClient.OwnerPermission, grantee: account })
  )

  /** One key or delegation of one audited permission. */
  export interface AuditedEntry {
    /** The audited account. */
    readonly account: string
    /** Its permission holding the entry. */
    readonly permission: string
    /** What the entry names. */
    readonly kind: EntryKind
    /** The key (normalized, {@link normalizeKey}), or the delegated `actor@permission`. */
    readonly subject: string
    /** The entry's weight in the permission's authority. */
    readonly weight: number
    /** Why it is allowed; `null` when the audit cannot classify it. */
    readonly classification: Classification
    /** The human reason, naming what the entry resolves to. */
    readonly reason: string
  }

  /** One audited permission. */
  export interface AuditedPermission {
    /** The account. */
    readonly account: string
    /** The permission. */
    readonly permission: string
    /** Its parent; empty for `owner`. */
    readonly parent: string
    /** Its threshold. */
    readonly threshold: number
    /** Every key and delegation, classified. */
    readonly entries: AuditedEntry[]
    /** The actions linked to it, as `code::action` (`code::*` for a contract-wide link). */
    readonly linkedActions: string[]
  }

  /** An action link the audit does not expect. */
  export interface UnexpectedLink {
    /** The account whose permission the link targets. */
    readonly account: string
    /** The permission it targets (`sysio.any` for a link to any permission). */
    readonly permission: string
    /** The linked action, as `code::action`. */
    readonly action: string
  }

  /** A permission whose whole authority differs from the one it must hold. */
  export interface AuthorityMismatch {
    /** The account. */
    readonly account: string
    /** The permission. */
    readonly permission: string
    /** The authority it must hold, or `null` when nothing names one. */
    readonly expected: SysioContracts.SysioSystemAuthorityType
    /** The authority the chain holds. */
    readonly actual: SysioContracts.SysioSystemAuthorityType
    /** What the expected authority is. */
    readonly reason: string
  }

  /** What one key can do on its own to one audited permission. */
  export interface KeyReach {
    /** The key, normalized ({@link normalizeKey}). */
    readonly key: string
    /** The audited account. */
    readonly account: string
    /** The permission. */
    readonly permission: string
    /** The weight the key alone gathers, directly and through satisfied delegations. */
    readonly weight: number
    /** The permission's threshold. */
    readonly threshold: number
    /** Whether the key alone satisfies the permission. */
    readonly satisfies: boolean
  }

  /** The accounts an audit covers, enumerated from the chain. */
  export interface AccountInventory {
    /** Every account to audit: genesis, every `sysio.*` account created, and every listed one that exists. */
    readonly accounts: string[]
    /** `sysio.*` accounts the chain created that the system-account list does not name. */
    readonly unlisted: string[]
    /** Listed system accounts the chain never created. */
    readonly missing: string[]
  }

  /** What to audit. */
  export interface AuditOptions {
    /** The accounts to audit — every permission of each ({@link AccountInventory.accounts}). */
    readonly accounts: ReadonlyArray<string>
    /** The account `sysio.andon`'s panic permissions delegate to. */
    readonly panicAccount: string
    /** The account `sysio.bond`'s ruling permissions delegate to. */
    readonly judgeAccount: string
    /** The keys whose reach the audit computes — the bootstrap `sysio` key(s), in any spelling. */
    readonly keys: ReadonlyArray<string>
    /** Whether `sysio` has been handed to a governance authority yet. */
    readonly phase: AuditPhase
    /** After a handoff: the governance authority `sysio@owner` and `@active` must delegate to alone. */
    readonly handedTo?: Constants.GovernanceAuthorityAccount
    /**
     * The members a written `sysio.cncl@active` must hold. `sysio.nodes@active`
     * is checked against the live `sysio.roa` tier-1 roster instead. When
     * omitted, a written `sysio.cncl@active` fails the audit.
     */
    readonly councilMembers?: ReadonlyArray<string>
  }

  /** The audit's findings. */
  export interface AuditResult {
    /** The keys whose reach the audit computed, normalized. */
    readonly keys: string[]
    /** Every audited permission, in account then permission order. */
    readonly permissions: AuditedPermission[]
    /** Every entry allowed by an exception other than plain `sysio@active` governance, with its reason. */
    readonly exceptions: AuditedEntry[]
    /** Every entry the audit cannot classify — each one fails the audit. */
    readonly unclassified: AuditedEntry[]
    /** Every permission whose authority differs from the one it must hold — each one fails the audit. */
    readonly mismatches: AuthorityMismatch[]
    /** Every action link the audit does not expect — each one fails the audit. */
    readonly unexpectedLinks: UnexpectedLink[]
    /** Every audited permission each checked key reaches with positive weight. */
    readonly keyReach: KeyReach[]
  }

  /**
   * Enumerate the accounts to audit from the chain's history: every account a
   * `sysio::newaccount` created (inline creations included), read from the
   * trace API from block {@link FirstTracedBlockNum} through LIB, plus the genesis
   * accounts. A creation the node traced without decoded `params` is read from
   * its encoded data with the `sysio` ABI, read once per scan. A node whose
   * trace history does not reach back to genesis cannot enumerate; pass the
   * accounts explicitly instead.
   *
   * @param wire - The WIRE client (its node must serve `/v1/trace_api`).
   * @param signal - The caller's cancellation.
   * @returns Every `sysio.*` account, the listed ones that exist, and the differences.
   * @throws When the node holds no trace for a block in range; NestedError,
   *   naming the block, when a traced creation carries no `params` and its data
   *   cannot be decoded.
   */
  export async function discoverSystemAccounts(
    wire: WireClient,
    signal: AbortSignal
  ): Promise<AccountInventory> {
    const lib = (await wire.getInfo()).last_irreversible_block_num,
      abis = new ABICache(wire.api),
      batches = chunk(range(FirstTracedBlockNum, lib + 1), TraceScanConcurrency),
      created = uniq(
        (
          await mapSeries(batches, async blockNums => {
            signal.throwIfAborted()
            return (
              await Promise.all(blockNums.map(blockNum => createdIn(wire, abis, blockNum)))
            ).flat()
          })
        ).flat()
      ),
      listed: string[] = [...Constants.SYSTEM_ACCOUNTS],
      genesis: string[] = [...GenesisAccounts],
      system = created.filter(account => account.startsWith(SystemAccountPrefix))
    log.info(
      `scanned blocks ${FirstTracedBlockNum}..${lib}: ${created.length} accounts created, ${system.length} under ${SystemAccountPrefix}`
    )
    return {
      accounts: sortBy(
        uniq([
          ...genesis,
          ...system,
          ...listed.filter(account => created.includes(account))
        ])
      ),
      unlisted: sortBy(
        system.filter(
          account => !listed.includes(account) && !genesis.includes(account)
        )
      ),
      missing: sortBy(listed.filter(account => !created.includes(account)))
    }
  }

  /** The accounts `sysio::newaccount` created in one block. */
  async function createdIn(
    wire: WireClient,
    abis: AbiProvider,
    blockNum: number
  ): Promise<string[]> {
    const block = await wire.getBlockTrace(blockNum)
    if (block == null)
      throw new Error(
        `authority audit: the node holds no trace of block ${blockNum}; pass the accounts to audit explicitly`
      )
    return Promise.all(
      block.transactions.flatMap(transaction =>
        transaction.actions
          .filter(
            action =>
              action.account === Constants.SYSIO_ACCOUNT &&
              action.receiver === Constants.SYSIO_ACCOUNT &&
              action.name === NewAccountAction
          )
          .map(action => createdAccount(abis, transaction, action))
      )
    )
  }

  /**
   * The account one traced `sysio::newaccount` created: from its decoded
   * `params`, or from its encoded data when the node did not decode it.
   */
  async function createdAccount(
    abis: AbiProvider,
    transaction: WireClient.TraceTransaction,
    action: WireClient.TraceAction
  ): Promise<string> {
    const { name } = await WireClient.decodeTraceActionData(
      abis,
      SysioContractName.system,
      NewAccountAction,
      action
    ).catch((error: unknown) => {
      throw new NestedError(
        `authority audit: block ${transaction.block_num} traces a ${Constants.SYSIO_ACCOUNT}::${NewAccountAction} whose new account cannot be read; read the traces from a node that decodes them, or pass the accounts to audit explicitly`,
        { cause: error, context: { transaction: transaction.id } }
      )
    })
    return name
  }

  /** Everything one audit pass reads once and classifies against. */
  interface AuditContext {
    readonly accounts: AccountCache
    readonly audited: string[]
    readonly options: AuditOptions
    /** The members each written governance authority must hold, by account; absent when nothing names them. */
    readonly expectedMembers: Map<string, ReadonlyArray<string>>
  }

  /**
   * Audit every permission of `options.accounts`.
   *
   * @param wire - The WIRE client.
   * @param options - What to audit.
   * @returns The findings; {@link assertClean} fails on any unclassified entry,
   *   authority mismatch or unexpected link.
   * @throws When an after-handoff audit names no authority `sysio` was handed to.
   */
  export async function audit(
    wire: WireClient,
    options: AuditOptions
  ): Promise<AuditResult> {
    Assert.ok(
      options.phase !== AuditPhase.afterHandoff || options.handedTo != null,
      "authority audit: an after-handoff audit must name the authority sysio was handed to"
    )
    const audited = sortBy(uniq([...options.accounts])),
      context: AuditContext = {
        accounts: new AccountCache(wire),
        audited,
        options,
        expectedMembers: await expectedMembers(wire, options)
      },
      keys = uniq(options.keys.map(normalizeKey)),
      responses = await mapSeries(audited, account => context.accounts.read(account)),
      permissions = await mapSeries(responses, async response =>
        Promise.all(
          response.permissions.map(permission =>
            auditPermission(context, String(response.account_name), permission)
          )
        )
      ).then(nested => nested.flat()),
      entries = permissions.flatMap(permission => permission.entries),
      mismatches = responses.flatMap(response =>
        response.permissions
          .map(permission =>
            authorityMismatch(context, String(response.account_name), permission)
          )
          .filter(mismatch => mismatch != null)
      ),
      unexpectedLinks = responses.flatMap(response => {
        const account = String(response.account_name)
        return [
          ...(response.sysio_any_linked_actions ?? []).map(link => ({
            account,
            permission: AnyPermission,
            action: linkSpelling(link)
          })),
          ...response.permissions.flatMap(permission =>
            (permission.linked_actions ?? [])
              .filter(
                link =>
                  !isDelegatedPermissionLink(
                    options,
                    account,
                    String(permission.perm_name),
                    link
                  )
              )
              .map(link => ({
                account,
                permission: String(permission.perm_name),
                action: linkSpelling(link)
              }))
          )
        ]
      }),
      keyReach = (
        await mapSeries(keys, key =>
          mapSeries(permissions, async permission => {
            const weight = await gatheredWeight(
              context.accounts,
              key,
              permission.account,
              permission.permission,
              0
            )
            return {
              key,
              account: permission.account,
              permission: permission.permission,
              weight,
              threshold: permission.threshold,
              satisfies: weight >= permission.threshold
            }
          })
        )
      )
        .flat()
        .filter(reach => reach.weight > 0)
    return {
      keys,
      permissions,
      exceptions: entries.filter(
        entry =>
          entry.classification != null &&
          entry.classification !== Classification.governance
      ),
      unclassified: entries.filter(entry => entry.classification == null),
      mismatches,
      unexpectedLinks,
      keyReach
    }
  }

  /**
   * The members each governance authority must hold once written:
   * `sysio.nodes` the live tier-1 roster, `sysio.cncl` the caller's council.
   */
  async function expectedMembers(
    wire: WireClient,
    options: AuditOptions
  ): Promise<Map<string, ReadonlyArray<string>>> {
    const expected = new Map<string, ReadonlyArray<string>>([
      [
        Constants.NODE_OWNERS_AUTHORITY,
        await WireNodeOwnerTool.readTierNodeOwners(wire, NodeOwnerTier.T1)
      ]
    ])
    if (options.councilMembers != null)
      expected.set(Constants.COUNCIL_AUTHORITY, options.councilMembers)
    return expected
  }

  /** `code::action`, or `code::*` for a contract-wide link. */
  function linkSpelling(link: API.v1.AccountLinkedAction): string {
    return `${link.account}::${link.action == null ? ContractWideAction : String(link.action)}`
  }

  /**
   * The native child permissions the bootstrap delegates on one system
   * contract: each is named after, and linked to, one of the contract's own
   * actions, and is satisfied by the delegate or by `sysio@active`.
   */
  interface DelegatedPermissions {
    /** The contract account holding the permissions. */
    readonly account: string
    /** The permissions, each named after the action it is linked to. */
    readonly permissions: ReadonlyArray<string>
    /** The account they delegate to beside `sysio@active`. */
    readonly delegate: string
    /** How a delegation to {@link delegate} is classified. */
    readonly classification: Classification
    /** What a reason calls the delegate. */
    readonly role: string
  }

  /** Every set of permissions the bootstrap delegates: the Andon panic permissions and the bond rulings. */
  function delegatedPermissions(options: AuditOptions): DelegatedPermissions[] {
    return [
      {
        account: AndonAccount,
        permissions: Object.values<string>(AndonContractSteps.Permission),
        delegate: options.panicAccount,
        classification: Classification.andonPanicDelegate,
        role: PanicRole
      },
      {
        account: BondAccount,
        permissions: Object.values<string>(BondContractSteps.Permission),
        delegate: options.judgeAccount,
        classification: Classification.bondJudgeDelegate,
        role: JudgeRole
      }
    ]
  }

  /** The delegated set `account@permission` belongs to, or absent when the bootstrap delegates no such permission. */
  function findDelegatedPermissions(
    options: AuditOptions,
    account: string,
    permission: string
  ): DelegatedPermissions {
    return delegatedPermissions(options).find(
      delegated =>
        delegated.account === account && delegated.permissions.includes(permission)
    )
  }

  /** Whether `link` is the one documented link of a delegated permission: its contract's own action of the same name. */
  function isDelegatedPermissionLink(
    options: AuditOptions,
    account: string,
    permission: string,
    link: API.v1.AccountLinkedAction
  ): boolean {
    return (
      findDelegatedPermissions(options, account, permission) != null &&
      String(link.account) === account &&
      String(link.action) === permission
    )
  }

  /** Whether `permission` is one every account has (`owner`, `active`). */
  function isNativePermission(permission: string): boolean {
    return (
      permission === WireClient.OwnerPermission ||
      permission === WireClient.ActivePermission
    )
  }

  /** Whether `account@permission` is `sysio`'s own `owner` or `active`. */
  function isRootPermission(account: string, permission: string): boolean {
    return account === Constants.SYSIO_ACCOUNT && isNativePermission(permission)
  }

  /** Whether `account@permission` is a governance authority's `active`, which `sysio.councl` writes. */
  function isGovernanceAuthorityActive(account: string, permission: string): boolean {
    return (
      Constants.isGovernanceAuthorityAccount(account) &&
      permission === WireClient.ActivePermission
    )
  }

  /** Whether `authority` is the unwritten `sysio.null@active` placeholder. */
  function isPlaceholder(authority: SysioContracts.SysioSystemAuthorityType): boolean {
    return isEqual(authority, WireSysioContractTool.sysioNullActiveAuthority())
  }

  /** Classify every entry of one permission. */
  async function auditPermission(
    context: AuditContext,
    account: string,
    permission: API.v1.AccountPermission
  ): Promise<AuditedPermission> {
    const name = String(permission.perm_name),
      auth = WireClient.toAuthorityType(permission.required_auth),
      keyEntries = auth.keys.map(({ key, weight }) =>
        classifyKey(context, account, name, normalizeKey(key), weight)
      ),
      accountEntries = await Promise.all(
        auth.accounts.map(({ permission: level, weight }) =>
          classifyDelegation(context, account, name, auth, level, weight)
        )
      )
    return {
      account,
      permission: name,
      parent: String(permission.parent),
      threshold: auth.threshold,
      entries: [...keyEntries, ...accountEntries],
      linkedActions: (permission.linked_actions ?? []).map(linkSpelling)
    }
  }

  /**
   * Classify a key entry: only `sysio`'s own `owner` / `active` may hold one,
   * and only BEFORE a handoff.
   */
  function classifyKey(
    context: AuditContext,
    account: string,
    permission: string,
    key: string,
    weight: number
  ): AuditedEntry {
    const isRootKey =
      context.options.phase === AuditPhase.beforeHandoff &&
      isRootPermission(account, permission)
    return {
      account,
      permission,
      kind: EntryKind.key,
      subject: key,
      weight,
      classification: isRootKey ? Classification.rootKey : null,
      reason: isRootKey
        ? `${Constants.SYSIO_ACCOUNT}'s own key: the authority a governance handoff replaces`
        : match(context.options.phase)
            .with(
              AuditPhase.afterHandoff,
              () =>
                `a key on ${account}@${permission}; after the handoff no ${Constants.SYSIO_ACCOUNT} permission or system account may hold one`
            )
            .otherwise(
              () =>
                `a key on ${account}@${permission}; only ${Constants.SYSIO_ACCOUNT}'s own owner and active may hold one`
            )
    }
  }

  /** Classify an account delegation. */
  async function classifyDelegation(
    context: AuditContext,
    account: string,
    permission: string,
    auth: SysioContracts.SysioSystemAuthorityType,
    level: SysioContracts.SysioSystemPermissionLevelType,
    weight: number
  ): Promise<AuditedEntry> {
    const { options } = context,
      { actor, permission: delegated } = level,
      subject = `${actor}@${delegated}`,
      unclassified: [Classification, string] = [
        null,
        unclassifiedReason(account, permission, subject)
      ],
      isGovernanceActive = isGovernanceAuthorityActive(account, permission),
      delegation = findDelegatedPermissions(options, account, permission),
      [classification, reason] = await match({ actor, delegated })
        .with(
          {
            actor: Constants.SYSIO_ACCOUNT,
            delegated: WireClient.ActivePermission
          },
          async (): Promise<[Classification, string]> =>
            isRootPermission(account, permission) || isGovernanceActive
              ? unclassified
              : [
                  Classification.governance,
                  `governed by ${Constants.SYSIO_ACCOUNT}@${WireClient.ActivePermission}`
                ]
        )
        .with(
          { delegated: WireClient.CodePermission },
          async (): Promise<[Classification, string]> =>
            BootstrapCodeGrants.some(grant =>
              isEqual(grant, { account, permission, grantee: actor })
            )
              ? actor === account
                ? [
                    Classification.ownContractCode,
                    `${account}'s own contract code acts for it, as the bootstrap grants; no key satisfies ${WireClient.CodePermission}`
                  ]
                : [
                    Classification.crossContractCode,
                    `${actor}'s contract code acts for ${account}@${permission}, as the bootstrap grants; no key satisfies ${WireClient.CodePermission}`
                  ]
              : unclassified
        )
        // Only the delegate of THIS permission: a delegate account named anywhere else falls
        // through, so one that is also a governance member or a producer is still classified.
        .with(
          {
            actor: P.when((candidate: string) => delegation?.delegate === candidate),
            delegated: WireClient.ActivePermission
          },
          async (): Promise<[Classification, string]> => [
            delegation.classification,
            `${account}@${permission} delegates to the ${delegation.role} account ${subject}, held by ${await describeKeys(context.accounts, actor, delegated)}`
          ]
        )
        .with(
          {
            actor: P.when(Constants.isGovernanceAuthorityAccount),
            delegated: WireClient.ActivePermission
          },
          async (): Promise<[Classification, string]> =>
            options.phase === AuditPhase.afterHandoff &&
            isRootPermission(account, permission) &&
            actor === options.handedTo
              ? [
                  Classification.governanceAuthority,
                  `${Constants.SYSIO_ACCOUNT}@${permission} is handed to the governance authority ${subject}`
                ]
              : unclassified
        )
        .with(
          { actor: Constants.NULL_ACCOUNT, delegated: WireClient.ActivePermission },
          async (): Promise<[Classification, string]> =>
            isGovernanceActive && isPlaceholder(auth)
              ? [
                  Classification.unsatisfiablePlaceholder,
                  `${account}@${permission} has not been written by sysio.councl yet; nothing satisfies ${subject}`
                ]
              : unclassified
        )
        .with(
          { delegated: WireClient.ActivePermission },
          async (): Promise<[Classification, string]> =>
            match({
              isMember:
                isGovernanceActive &&
                (context.expectedMembers.get(account) ?? []).includes(actor),
              isProducers: account === Constants.PRODUCERS_ACCOUNT
            })
              .with(
                { isMember: true },
                (): [Classification, string] => [
                  Classification.governanceAuthorityMember,
                  `${subject} is an expected member of the governance authority ${account}`
                ]
              )
              .with(
                { isProducers: true },
                (): [Classification, string] => [
                  Classification.producerAuthority,
                  `${subject} is a scheduled producer; the chain keeps ${account}@${permission} equal to the schedule`
                ]
              )
              .otherwise((): [Classification, string] => unclassified)
        )
        .otherwise(async (): Promise<[Classification, string]> => unclassified)
    return {
      account,
      permission,
      kind: EntryKind.account,
      subject,
      weight,
      classification,
      reason
    }
  }

  /** The reason an entry is unclassified. */
  function unclassifiedReason(
    account: string,
    permission: string,
    subject: string
  ): string {
    return `${account}@${permission} delegates to ${subject}, which is neither ${Constants.SYSIO_ACCOUNT}@${WireClient.ActivePermission} nor a documented exception`
  }

  /**
   * The mismatch, if any, between a permission and the WHOLE authority it must
   * hold: `sysio@owner` / `@active` after a handoff, and a written governance
   * authority's `active`. Every other permission is judged entry by entry.
   */
  function authorityMismatch(
    context: AuditContext,
    account: string,
    permission: API.v1.AccountPermission
  ): AuthorityMismatch {
    const name = String(permission.perm_name),
      actual = WireClient.toAuthorityType(permission.required_auth),
      { options } = context,
      handedTo = options.phase === AuditPhase.afterHandoff && options.handedTo === account
    return match({
      root: options.phase === AuditPhase.afterHandoff && isRootPermission(account, name),
      governance: isGovernanceAuthorityActive(account, name)
    })
      .with({ root: true }, (): AuthorityMismatch => {
        const expected = WireSysioContractTool.delegatedAuthority(options.handedTo)
        return isEqual(actual, expected)
          ? null
          : {
              account,
              permission: name,
              expected,
              actual,
              reason: `after the handoff ${account}@${name} must delegate to ${options.handedTo}@${WireClient.ActivePermission} alone`
            }
      })
      .with({ governance: true }, (): AuthorityMismatch => {
        const members = context.expectedMembers.get(account),
          expected = members == null ? null : GovernanceSteps.supermajorityAuthority(members)
        return match({ placeholder: isPlaceholder(actual) })
          .with({ placeholder: true }, (): AuthorityMismatch =>
            handedTo
              ? {
                  account,
                  permission: name,
                  expected,
                  actual,
                  reason: `${Constants.SYSIO_ACCOUNT} was handed to ${account}, whose ${name} is still the unwritten placeholder`
                }
              : null
          )
          .otherwise((): AuthorityMismatch =>
            expected != null && isEqual(actual, expected)
              ? null
              : {
                  account,
                  permission: name,
                  expected,
                  actual,
                  reason:
                    expected == null
                      ? `${account}@${name} is written, but the audit was given no members it must hold`
                      : `${account}@${name} must be [${[...members].join(", ")}] at ${expected.threshold}`
                }
          )
      })
      .otherwise((): AuthorityMismatch => null)
  }

  /** The keys that satisfy `actor@permission` directly, for an exception's reason. */
  async function describeKeys(
    accounts: AccountCache,
    actor: string,
    permission: string
  ): Promise<string> {
    const found = findPermission(await accounts.read(actor), permission),
      keys = found == null ? [] : WireClient.toAuthorityType(found.required_auth).keys
    return keys.length === 0
      ? "no key of its own"
      : `key(s) ${keys.map(({ key }) => normalizeKey(key)).join(", ")}`
  }

  /** `account`'s permission named `permission`, or absent. */
  function findPermission(
    account: API.v1.AccountObject,
    permission: string
  ): API.v1.AccountPermission {
    return account.permissions.find(candidate => String(candidate.perm_name) === permission)
  }

  /**
   * The weight `key` ALONE gathers toward `account@permission`: its own weight
   * in the authority plus the weight of every delegation it satisfies alone. A
   * delegation `X@Q` is satisfied by satisfying `Q` or any ancestor of `Q`
   * (`owner` satisfies `active`); `@sysio.code` is satisfied by no key. The
   * walk follows delegations {@link Constants.MAX_AUTHORITY_DEPTH} deep, as the
   * chain does; a deeper one counts as unsatisfied.
   */
  async function gatheredWeight(
    accounts: AccountCache,
    key: string,
    account: string,
    permission: string,
    depth: number
  ): Promise<number> {
    if (depth > Constants.MAX_AUTHORITY_DEPTH) return 0
    const found = findPermission(await accounts.read(account), permission)
    if (found == null) return 0
    const auth = WireClient.toAuthorityType(found.required_auth),
      keyWeight = auth.keys
        .filter(entry => normalizeKey(entry.key) === key)
        .reduce((sum, entry) => sum + entry.weight, 0),
      delegatedWeights = await Promise.all(
        auth.accounts.map(async ({ permission: level, weight }) =>
          (await levelSatisfied(accounts, key, level, depth + 1)) ? weight : 0
        )
      )
    return keyWeight + delegatedWeights.reduce((sum, weight) => sum + weight, 0)
  }

  /** Whether `key` alone satisfies the delegated level, through the level or any of its ancestors. */
  async function levelSatisfied(
    accounts: AccountCache,
    key: string,
    level: SysioContracts.SysioSystemPermissionLevelType,
    depth: number
  ): Promise<boolean> {
    if (level.permission === WireClient.CodePermission) return false
    const response = await accounts.read(level.actor),
      results = await Promise.all(
        ancestry(response, level.permission).map(async permission => {
          const found = findPermission(response, permission)
          return (
            found != null &&
            (await gatheredWeight(accounts, key, level.actor, permission, depth)) >=
              Number(found.required_auth.threshold)
          )
        })
      )
    return results.some(Boolean)
  }

  /** `permission` and each of its ancestors up to `owner`. */
  function ancestry(response: API.v1.AccountObject, permission: string): string[] {
    const found = findPermission(response, permission),
      parent = found == null ? null : String(found.parent)
    return found == null
      ? []
      : [
          permission,
          ...(parent === WireClient.OwnerParent || parent === permission
            ? []
            : ancestry(response, parent))
        ]
  }

  /**
   * One spelling per key, so a legacy `SYS…` key matches its `PUB_K1_…` form.
   *
   * @param key - A public key in any spelling sdk-core parses.
   * @returns Its sdk-core `PUB_` spelling.
   * @throws When `key` is not a public key.
   */
  export function normalizeKey(key: string): string {
    return PublicKey.from(key).toString()
  }

  /**
   * Fail on any entry the audit could not classify, any authority that differs
   * from the one it must hold, any unexpected action link, and any listed
   * system account the chain never created.
   *
   * @param result - The audit's findings.
   * @param inventory - The enumerated accounts, when the audit's accounts came from {@link discoverSystemAccounts}.
   * @throws Naming every finding.
   */
  export function assertClean(
    result: AuditResult,
    inventory: AccountInventory = null
  ): void {
    const findings = [
      ...result.unclassified.map(
        entry => `unclassified ${entry.kind} ${entry.subject} on ${entry.account}@${entry.permission}: ${entry.reason}`
      ),
      ...result.mismatches.map(
        mismatch => `authority of ${mismatch.account}@${mismatch.permission} differs: ${mismatch.reason} (holds ${JSON.stringify(mismatch.actual)})`
      ),
      ...result.unexpectedLinks.map(
        link => `unexpected link of ${link.action} to ${link.account}@${link.permission}`
      ),
      ...(inventory?.missing ?? []).map(
        account => `system account ${account} does not exist on chain`
      )
    ]
    if (findings.length > 0)
      throw new Error(
        `authority audit failed (${findings.length}):\n  ${findings.join("\n  ")}`
      )
  }

  /**
   * Fail when `key` alone still satisfies any audited permission other than the
   * delegated ones (the `sysio.andon` panic permissions and the `sysio.bond`
   * rulings) — the check after a handoff that the retired bootstrap key no
   * longer reaches anything it should not.
   *
   * @param result - The audit's findings.
   * @param key - The retired key, in any spelling.
   * @throws When the audit did not compute `key`'s reach, or naming every
   *   permission the key still satisfies.
   */
  export function assertKeyRetired(result: AuditResult, key: string): void {
    const normalized = normalizeKey(key)
    if (!result.keys.includes(normalized))
      throw new Error(
        `the key ${normalized} was not audited (audited: ${result.keys.join(", ") || "none"}); its reach is unknown`
      )
    const delegated = result.exceptions
        .filter(entry => DelegateClassifications.includes(entry.classification))
        .map(entry => `${entry.account}@${entry.permission}`),
      offenders = result.keyReach
        .filter(reach => reach.key === normalized && reach.satisfies)
        .map(reach => `${reach.account}@${reach.permission}`)
        .filter(permission => !delegated.includes(permission))
    if (offenders.length > 0)
      throw new Error(
        `the retired key ${normalized} still satisfies ${offenders.join(", ")} on its own`
      )
  }

  /**
   * The audit's findings as report lines: each exception it allowed and why,
   * each failure, and each permission a checked key reaches.
   *
   * @param result - The audit's findings.
   * @param inventory - The enumerated accounts, when known.
   * @returns One line per finding.
   */
  export function describe(
    result: AuditResult,
    inventory: AccountInventory = null
  ): string[] {
    return [
      ...(inventory == null
        ? []
        : [
            `audited ${inventory.accounts.length} accounts: ${inventory.accounts.join(", ")}`,
            ...inventory.unlisted.map(
              account => `unlisted system account ${account} (audited)`
            ),
            ...inventory.missing.map(account => `MISSING system account ${account}`)
          ]),
      ...result.exceptions.map(
        entry =>
          `exception ${entry.classification}: ${entry.account}@${entry.permission} <- ${entry.subject} (${entry.reason})`
      ),
      ...result.unclassified.map(
        entry =>
          `UNCLASSIFIED ${entry.kind}: ${entry.account}@${entry.permission} <- ${entry.subject} (${entry.reason})`
      ),
      ...result.mismatches.map(
        mismatch => `MISMATCHED authority ${mismatch.account}@${mismatch.permission}: ${mismatch.reason}`
      ),
      ...result.unexpectedLinks.map(
        link => `UNEXPECTED link ${link.action} -> ${link.account}@${link.permission}`
      ),
      ...result.keyReach.map(
        reach =>
          `key ${reach.key} ${reach.satisfies ? "SATISFIES" : "contributes to"} ${reach.account}@${reach.permission} (${reach.weight}/${reach.threshold})`
      )
    ]
  }

  /** Reads each account once per audit, however many delegations name it. */
  class AccountCache {
    private readonly reads = new Map<string, Promise<API.v1.AccountObject>>()

    constructor(private readonly wire: WireClient) {}

    read(account: string): Promise<API.v1.AccountObject> {
      if (!this.reads.has(account))
        this.reads.set(account, this.wire.api.v1.chain.get_account(account))
      return this.reads.get(account)
    }
  }
}
