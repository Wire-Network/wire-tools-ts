import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, Name } from "@wireio/sdk-core"
import { z } from "zod"

import { AWSAccountName } from "../config/AWSClusterNodeConfig.js"
import { SchemaCodec } from "../schema/index.js"
import {
  EvmAddressPattern,
  SolanaAddressPattern
} from "../types/chainAddressPatterns.js"
import { OperatorTypeCodec } from "../types/OperatorTypeCodec.js"

/**
 * Constants of `wire-opreg-bootstrap.json` (`ClusterFiles.WireOpregBootstrapFilename`)
 * — the bootstrapped operator roster and the initial batch-operator schedule a
 * cluster bootstrap writes into its cluster directory.
 */
export namespace WireOpregBootstrap {
  /**
   * The operator types a roster entry admits, in roster order. The current depot
   * registers only PRODUCER and BATCH operators as bootstrapped
   * (`sysio.opreg::regoperator` refuses a bootstrapped underwriter); UNDERWRITER
   * is admitted so the shape does not change if that rule does.
   */
  export const OperatorTypes: readonly OperatorType[] = [
    OperatorType.PRODUCER,
    OperatorType.BATCH,
    OperatorType.UNDERWRITER
  ]

  /**
   * A cluster build label — the `WIRE_CLUSTER_LABEL` grammar the
   * `create-wire-platform-cluster` workflow enforces (lowercase letters, digits,
   * `-` and `_`). Changing it changes which labels a document admits.
   */
  export const LabelPattern = /^[a-z0-9_-]+$/

  /** A BLS proof of possession — `SIG_BLS_` + a base64url body. */
  export const ProofOfPossessionPattern = /^SIG_BLS_[0-9A-Za-z_-]+$/

  /**
   * The Wire-canonical public key pattern of a curve — `PUB_<type>_` + a
   * base58 / base64url body.
   *
   * @param type - The key's curve.
   * @returns The anchored pattern.
   */
  export function publicKeyPattern(type: KeyType): RegExp {
    return new RegExp(`^PUB_${type}_[0-9A-Za-z_-]+$`)
  }

  /** JSON Schema title of the document. */
  export const Title = "WIRE opreg bootstrap"

  /** JSON Schema description of the document. */
  export const Description =
    "The cluster's build label and AWS account, the bootstrapped operator roster " +
    "(every sysio.opreg operator registered with is_bootstrapped: WIRE account name, " +
    "operator type, public keys) and the initial batch-operator schedule " +
    "sysio.epoch::schbatchgps built, written by the cluster-tool bootstrap to " +
    "<clusterPath>/wire-opreg-bootstrap.json."
}

/** A WIRE account name — non-empty and canonical per sdk-core's `Name.pattern`. */
const AccountNameSchema = z
  .string()
  .min(1)
  .regex(Name.pattern)
  .describe("WIRE account name")

/** The roster entry's account field — the `sysio.opreg::operators` row key. */
const OperatorAccountNameSchema = AccountNameSchema.describe(
  "WIRE account name — the sysio.opreg::operators row key"
)

/**
 * The public half every key slot carries: its curve, pinned to `type` for the
 * slot, and its Wire-canonical public key.
 *
 * @param type - The slot's curve.
 * @returns The slot's base object schema.
 */
function publicKeySchema<T extends KeyType>(type: T) {
  return z.object({
    type: z.literal(type).describe(`Key type — always ${type} in this slot`),
    publicKey: z
      .string()
      .regex(WireOpregBootstrap.publicKeyPattern(type))
      .describe(`Wire-canonical public key (PUB_${type}_…)`)
  })
}

/**
 * One roster-entry variant: the account, the operator `type` restricted to one
 * member (JSON carries its NAME), and the key slots that type carries.
 *
 * @param type - The variant's operator type.
 * @param keys - The variant's key-slot object schema.
 * @param description - The variant's JSON Schema description.
 * @returns The variant's object schema.
 */
function rosterEntrySchema<T extends OperatorType, K extends z.ZodType>(
  type: T,
  keys: K,
  description: string
) {
  return z
    .object({
      accountName: OperatorAccountNameSchema,
      type: OperatorTypeCodec.create([type]).describe(
        `Operator type — always ${OperatorType[type]} for this entry`
      ),
      keys
    })
    .describe(description)
}

/** The WIRE account key slot (K1) — every operator. */
export const WireOpregBootstrapWireKeySchema = publicKeySchema(
  KeyType.K1
).describe("WIRE account key (K1)")

/** The WIRE finality key slot (BLS) — producers. */
export const WireOpregBootstrapWireFinalizerKeySchema = publicKeySchema(
  KeyType.BLS
)
  .extend({
    proofOfPossession: z
      .string()
      .regex(WireOpregBootstrap.ProofOfPossessionPattern)
      .describe("BLS proof of possession (SIG_BLS_…)")
  })
  .describe("WIRE finality key (BLS)")

/** The Ethereum key slot (EM) — batch operators and underwriters. */
export const WireOpregBootstrapEthereumKeySchema = publicKeySchema(KeyType.EM)
  .extend({
    address: z
      .string()
      .regex(EvmAddressPattern)
      .describe("EVM address of the key (0x…)")
  })
  .describe("Ethereum key (EM)")

/** The Solana key slot (ED) — batch operators and underwriters. */
export const WireOpregBootstrapSolanaKeySchema = publicKeySchema(KeyType.ED)
  .extend({
    address: z
      .string()
      .regex(SolanaAddressPattern)
      .describe("Solana address of the key (base58 public key)")
  })
  .describe("Solana key (ED)")

/** A producer's public keys — exactly `wire` and `wireFinalizer`. */
export const WireOpregBootstrapProducerKeysSchema = z
  .strictObject({
    wire: WireOpregBootstrapWireKeySchema,
    wireFinalizer: WireOpregBootstrapWireFinalizerKeySchema
  })
  .describe("A producer's public keys: the WIRE account key and the WIRE finality key")

/** An OPP operator's (batch operator / underwriter) public keys — exactly `wire`, `ethereum` and `solana`. */
export const WireOpregBootstrapOppOperatorKeysSchema = z
  .strictObject({
    wire: WireOpregBootstrapWireKeySchema,
    ethereum: WireOpregBootstrapEthereumKeySchema,
    solana: WireOpregBootstrapSolanaKeySchema
  })
  .describe(
    "A batch operator's or underwriter's public keys: the WIRE account key and its Ethereum and Solana keys"
  )

/** A bootstrapped PRODUCER roster entry. */
export const WireOpregBootstrapProducerSchema = rosterEntrySchema(
  OperatorType.PRODUCER,
  WireOpregBootstrapProducerKeysSchema,
  "A bootstrapped producer"
)

/** A bootstrapped BATCH roster entry. */
export const WireOpregBootstrapBatchOperatorSchema = rosterEntrySchema(
  OperatorType.BATCH,
  WireOpregBootstrapOppOperatorKeysSchema,
  "A bootstrapped batch operator"
)

/** A bootstrapped UNDERWRITER roster entry (admitted; the current depot registers none). */
export const WireOpregBootstrapUnderwriterSchema = rosterEntrySchema(
  OperatorType.UNDERWRITER,
  WireOpregBootstrapOppOperatorKeysSchema,
  "A bootstrapped underwriter"
)

/** One bootstrapped operator — discriminated on `type`, which fixes the entry's key slots. */
export const WireOpregBootstrapOperatorSchema = z
  .discriminatedUnion("type", [
    WireOpregBootstrapProducerSchema,
    WireOpregBootstrapBatchOperatorSchema,
    WireOpregBootstrapUnderwriterSchema
  ])
  .describe("One operator registered on sysio.opreg with is_bootstrapped")

/** The initial batch-operator schedule `sysio.epoch::schbatchgps` built. */
export const WireOpregBootstrapBatchOperatorGroupsSchema = z
  .object({
    activeGroupIndex: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Index into groups of the first active group — sysio.epoch epochstate.current_batch_op_group " +
          "when the file is written (0: the front of the window is always the current group)"
      ),
    groups: z
      .array(z.array(AccountNameSchema).min(1))
      .min(1)
      .describe(
        "The batch-operator window in slot order (sysio.epoch epochstate.batch_op_groups): " +
          "groups[k] serves epoch k + 1; each member is the accountName of a BATCH operator in operators"
      )
  })
  .describe("The initial batch-operator schedule built by sysio.epoch::schbatchgps")

/** The document's fields before its cross-field consistency checks. */
const WireOpregBootstrapShape = z.object({
  label: z
    .string()
    .regex(WireOpregBootstrap.LabelPattern)
    .nullable()
    .describe(
      "The cluster build label (^[a-z0-9_-]+$) — the WIRE_CLUSTER_LABEL of the " +
        "create-wire-platform-cluster run that built the cluster, set by that workflow " +
        "after a successful create; null when the cluster-tool writes the file"
    ),
  awsAccount: z
    .enum(AWSAccountName)
    .nullable()
    .describe(
      "The AWS account (environment) the cluster's nodes run in — awsClusterNodeConfig.account " +
        "of the cluster config; null when the cluster has no AWS placement"
    ),
  epochDurationSec: z
    .number()
    .int()
    .positive()
    .describe(
      "The depot's global epoch duration in seconds (sysio.epoch::epochcfg.epoch_duration_sec)"
    ),
  operators: z
    .array(WireOpregBootstrapOperatorSchema)
    .min(1)
    .describe("Every bootstrapped operator, ordered by operator type then account name"),
  batchOperatorGroups: WireOpregBootstrapBatchOperatorGroupsSchema
})

/** The decoded fields {@link addConsistencyIssues} checks. */
type WireOpregBootstrapFields = z.infer<typeof WireOpregBootstrapShape>

/** The refinement context of {@link WireOpregBootstrapShape}. */
type WireOpregBootstrapRefinementContext =
  z.core.$RefinementCtx<WireOpregBootstrapFields>

/**
 * The document's cross-field consistency, reported as one issue (with its
 * `path`) per finding. Runs on decode AND encode, always over the DECODED value
 * — `type` is the numeric `OperatorType`. (Each entry's key slots are fixed by
 * its `type` variant, not here.)
 *
 * @param value - The decoded document.
 * @param ctx - The refinement context issues are added to.
 */
function addConsistencyIssues(
  value: WireOpregBootstrapFields,
  ctx: WireOpregBootstrapRefinementContext
): void {
  addDuplicateAccountIssues(value, ctx)
  addActiveGroupIssue(value, ctx)
  addGroupMemberIssues(value, ctx)
}

/** An `accountName` that appears more than once in `operators`. */
function addDuplicateAccountIssues(
  { operators }: WireOpregBootstrapFields,
  ctx: WireOpregBootstrapRefinementContext
): void {
  operators
    .map((operator, index) => ({ operator, index }))
    .filter(
      ({ operator, index }) =>
        operators.findIndex(
          other => other.accountName === operator.accountName
        ) !== index
    )
    .forEach(({ operator, index }) =>
      ctx.addIssue({
        code: "custom",
        message: `duplicate accountName ${operator.accountName}`,
        path: ["operators", index, "accountName"]
      })
    )
}

/** An `activeGroupIndex` past the last group. */
function addActiveGroupIssue(
  { batchOperatorGroups }: WireOpregBootstrapFields,
  ctx: WireOpregBootstrapRefinementContext
): void {
  const { activeGroupIndex, groups } = batchOperatorGroups
  if (activeGroupIndex >= groups.length) {
    ctx.addIssue({
      code: "custom",
      message: `activeGroupIndex ${activeGroupIndex} is out of range for ${groups.length} group(s)`,
      path: ["batchOperatorGroups", "activeGroupIndex"]
    })
  }
}

/** A group member that repeats within its group or is not a BATCH roster entry. */
function addGroupMemberIssues(
  { operators, batchOperatorGroups }: WireOpregBootstrapFields,
  ctx: WireOpregBootstrapRefinementContext
): void {
  const typeByAccount = new Map<string, OperatorType>(
    operators.map(operator => [operator.accountName, operator.type])
  )
  batchOperatorGroups.groups.forEach((group, groupIndex) =>
    group.forEach((member, memberIndex) => {
      const path = ["batchOperatorGroups", "groups", groupIndex, memberIndex]
      if (group.indexOf(member) !== memberIndex) {
        ctx.addIssue({
          code: "custom",
          message: `${member} appears more than once in group ${groupIndex}`,
          path
        })
      }
      if (typeByAccount.get(member) !== OperatorType.BATCH) {
        ctx.addIssue({
          code: "custom",
          message: `group member ${member} is not a BATCH operator in operators`,
          path
        })
      }
    })
  )
}

/**
 * THE `wire-opreg-bootstrap.json` schema — the cluster's build label and AWS
 * account, the bootstrapped operator roster, the initial batch-operator schedule
 * and the depot's epoch duration, with the cross-field consistency checks
 * applied.
 */
export const WireOpregBootstrapSchema = WireOpregBootstrapShape.superRefine(
  addConsistencyIssues
).meta({
  title: WireOpregBootstrap.Title,
  description: WireOpregBootstrap.Description
})

/** The WIRE account key slot — the shape of {@link WireOpregBootstrapWireKeySchema}. */
export type WireOpregBootstrapWireKey = z.infer<
  typeof WireOpregBootstrapWireKeySchema
>
/** The WIRE finality key slot — the shape of {@link WireOpregBootstrapWireFinalizerKeySchema}. */
export type WireOpregBootstrapWireFinalizerKey = z.infer<
  typeof WireOpregBootstrapWireFinalizerKeySchema
>
/** The Ethereum key slot — the shape of {@link WireOpregBootstrapEthereumKeySchema}. */
export type WireOpregBootstrapEthereumKey = z.infer<
  typeof WireOpregBootstrapEthereumKeySchema
>
/** The Solana key slot — the shape of {@link WireOpregBootstrapSolanaKeySchema}. */
export type WireOpregBootstrapSolanaKey = z.infer<
  typeof WireOpregBootstrapSolanaKeySchema
>
/** A producer's public keys — the shape of {@link WireOpregBootstrapProducerKeysSchema}. */
export type WireOpregBootstrapProducerKeys = z.infer<
  typeof WireOpregBootstrapProducerKeysSchema
>
/** An OPP operator's public keys — the shape of {@link WireOpregBootstrapOppOperatorKeysSchema}. */
export type WireOpregBootstrapOppOperatorKeys = z.infer<
  typeof WireOpregBootstrapOppOperatorKeysSchema
>
/** A bootstrapped producer — the shape of {@link WireOpregBootstrapProducerSchema}. */
export type WireOpregBootstrapProducer = z.infer<
  typeof WireOpregBootstrapProducerSchema
>
/** A bootstrapped batch operator — the shape of {@link WireOpregBootstrapBatchOperatorSchema}. */
export type WireOpregBootstrapBatchOperator = z.infer<
  typeof WireOpregBootstrapBatchOperatorSchema
>
/** A bootstrapped underwriter — the shape of {@link WireOpregBootstrapUnderwriterSchema}. */
export type WireOpregBootstrapUnderwriter = z.infer<
  typeof WireOpregBootstrapUnderwriterSchema
>
/** One bootstrapped operator — the shape of {@link WireOpregBootstrapOperatorSchema}. */
export type WireOpregBootstrapOperator = z.infer<
  typeof WireOpregBootstrapOperatorSchema
>
/** The initial batch-operator schedule — the shape of {@link WireOpregBootstrapBatchOperatorGroupsSchema}. */
export type WireOpregBootstrapBatchOperatorGroups = z.infer<
  typeof WireOpregBootstrapBatchOperatorGroupsSchema
>
/** THE `wire-opreg-bootstrap.json` document — the shape of {@link WireOpregBootstrapSchema}. */
export type WireOpregBootstrap = z.infer<typeof WireOpregBootstrapSchema>

/** Validated codec for `wire-opreg-bootstrap.json` (`ClusterFiles.WireOpregBootstrapFilename`). */
export const WireOpregBootstrapSchemaCodec =
  SchemaCodec.create<WireOpregBootstrap>(WireOpregBootstrapSchema)
