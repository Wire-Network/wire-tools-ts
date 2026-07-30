import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { asOption, Either } from "@3fv/prelude-ts"
import { isString, Level, NestedError } from "@wireio/shared"
import {
  AWSClusterNodeConfigSchemaCodec,
  AWSSSMSignatureProviderOptionsSchema,
  ChainTokenAmountSchema,
  CollateralRequirementSchema,
  SchemaCodec,
  SignatureProviderType,
  type AWSClusterNodeConfig,
  type AWSSSMSignatureProviderOptions,
  type ChainTokenAmount,
  type CollateralRequirement
} from "@wireio/cluster-tool-shared"
import { camelCase, defaultsDeep, identity, isPlainObject, range } from "lodash"
import { match, P } from "ts-pattern"
import type { Argv, Options as YargsOption } from "yargs"
import { z } from "zod"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { LogFileAppender } from "../logging/LogFileAppender.js"

/**
 * CLI-layer defaults for the {@link ClusterBuildOptions} topology / epoch leaves
 * — the values the `wire-cluster-tool` CLI and every `flow-*` executable have
 * always used (a minimal single-node test cluster on a 60s epoch). These are the
 * flag defaults; a caller's `defaults` (a flow's `Scenario.defaults`) or an
 * explicit flag overrides them.
 *
 * NOTE: these are intentionally the *CLI* defaults and are distinct from
 * `ClusterConfigProvider.Default*` (the resolve-time fallbacks used when an option is
 * fully unset), which differ for producer count (21) and epoch duration (90s).
 * The CLI has always pinned 1 / 60 here; changing them would silently alter the
 * topology + cadence of every flow. Leave them unless the divergence is being
 * resolved deliberately.
 */
const CliDefault = {
  nodeCount: 1,
  producerCount: 1,
  batchOperatorCount: 3,
  underwriterCount: 1,
  epochDurationSec: 60
} as const

/** The dedicated `--signature-provider-ssm` flag: inline JSON, or a file path when the value doesn't start with `{`. */
export const SignatureProviderSSMFlag = "signature-provider-ssm"

/**
 * The dedicated `--cluster-build-options-file` flag: a JSON document carrying a
 * whole {@link ClusterBuildOptions} — every scalar leaf `buildOptionShape`
 * describes, the flag-less collateral arrays, and the out-of-shape
 * `signatureProvider.ssm`. It does NOT carry `awsClusterNodeConfig` (that has
 * its own {@link AWSClusterNodeConfigFlag}).
 */
export const ClusterBuildOptionsFileFlag = "cluster-build-options-file"

/** The dedicated `--aws-cluster-node-config` flag: a path to an `AWSClusterNodeConfig` JSON file. */
export const AWSClusterNodeConfigFlag = "aws-cluster-node-config"

/** Validated codec for the `--signature-provider-ssm` payload. */
const ssmOptionsCodec = SchemaCodec.create<AWSSSMSignatureProviderOptions>(
  AWSSSMSignatureProviderOptionsSchema
)

/**
 * Validated codec for the three flag-less `CollateralRequirement[]` members of a
 * build-options document. REUSES the shared `CollateralRequirementSchema` — the
 * options document is never re-declared as a zod mirror of
 * {@link ClusterBuildOptions} (`buildOptionShape` is the runtime source of truth
 * for every scalar leaf); these two codecs cover ONLY the object-array members
 * that shape deliberately declares empty.
 */
const collateralRequirementsCodec = SchemaCodec.create<CollateralRequirement[]>(
  z.array(CollateralRequirementSchema)
)

/** Validated codec for the flag-less per-underwriter `ChainTokenAmount[][]` member. */
const underwriterCollateralCodec = SchemaCodec.create<ChainTokenAmount[][]>(
  z.array(z.array(ChainTokenAmountSchema))
)

/** A scalar option-leaf value — the yargs primitive kinds a flag can carry. */
export type OptionLeafValue = string | number | boolean

/**
 * The yargs primitive type of a leaf. String values are identical to yargs' own
 * `type` spellings so the enum is the single source of truth for both.
 */
export enum OptionLeafType {
  string = "string",
  number = "number",
  boolean = "boolean"
}

/**
 * The canonical spec for one scalar option leaf: its seeded default `value`
 * (`null` = no default / resolved later, e.g. an auto-picked bind port), the
 * yargs `describe`, whether it is `required` (→ `demandOption` when unseeded),
 * and an `explicitType` used ONLY when `value` is `null` (a type can't be
 * inferred from `null`). A non-null `value` infers its own type.
 */
export class OptionLeafSpec {
  constructor(
    readonly value: OptionLeafValue | null,
    readonly describe: string,
    readonly required = false,
    readonly explicitType: OptionLeafType | null = null,
    readonly choices: readonly string[] | null = null
  ) {}
}

/**
 * One node in the canonical option-shape descriptor: a scalar {@link
 * OptionLeafSpec}, a numerically-indexed array of nodes, or a nested object of
 * nodes. The recursive union both the descriptor and {@link flattenOptionLeaves}
 * walk.
 */
export type OptionShapeNode =
  | OptionLeafSpec
  | OptionShapeNode[]
  | OptionShapeObject

/** A nested object of shape nodes (named — no inline object types). */
export interface OptionShapeObject {
  [key: string]: OptionShapeNode
}

/**
 * A single flattened option leaf: its dotted `path` segments, the derived
 * `--kebab-path` `flag`, the inferred yargs `type`, the seeded default `value`
 * (`null` = none), its `describe`, and whether it is `required`. Drives BOTH
 * registration and the reverse parse, so the path↔flag machinery exists once.
 */
export interface OptionLeaf {
  path: string[]
  flag: string
  type: OptionLeafType
  value: OptionLeafValue | null
  describe: string
  required: boolean
  choices: readonly string[] | null
}

/** Scalar leaf whose yargs type is inferred from a non-null default `value`. */
function leaf(value: OptionLeafValue, describe: string): OptionLeafSpec {
  return new OptionLeafSpec(value, describe)
}

/** Optional leaf with no default (resolved later); the `type` must be explicit. */
function optionalLeaf(type: OptionLeafType, describe: string): OptionLeafSpec {
  return new OptionLeafSpec(null, describe, false, type)
}

/** Required leaf with no default — `demandOption` unless a caller seeds it. */
function requiredLeaf(type: OptionLeafType, describe: string): OptionLeafSpec {
  return new OptionLeafSpec(null, describe, true, type)
}

/** String leaf constrained to `choices` (yargs enforces the set), with a seeded default. */
function choicesLeaf(
  choices: readonly string[],
  value: OptionLeafValue,
  describe: string
): OptionLeafSpec {
  return new OptionLeafSpec(value, describe, false, null, choices)
}

/**
 * Kebab-case ONE path segment: break camelCase humps (`epochDurationSec` →
 * `epoch-duration-sec`, `debuggingServer` → `debugging-server`) and lowercase,
 * but keep letter↔digit boundaries intact so `p2p` stays `p2p` (NOT `p-2-p`) and
 * `terminateWindowMs` → `terminate-window-ms`. Deliberately NOT lodash
 * `kebabCase`, which splits on every digit boundary. Array-index segments (all
 * digits) and single-word segments pass through unchanged.
 */
function kebabSegment(segment: string): string {
  return segment
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

/**
 * Join dotted path segments into a `--kebab-path` flag: each segment is
 * kebab-cased individually (camelCase humps only — see {@link kebabSegment}) and
 * joined with `-`. Numeric array-index segments are their own path elements, so
 * they surface as `-<index>-` via the join. The single home of the path→flag
 * conversion.
 *
 * @param path - The dotted option path as segments (e.g. `["bind","kiod","port"]`).
 * @returns The kebab flag body (e.g. `"bind-kiod-port"`).
 * @example
 *   toFlag(["bind", "nodeop", "ports", "producers", "0", "http"])
 *   // "bind-nodeop-ports-producers-0-http"
 */
export function toFlag(path: string[]): string {
  return path.map(segment => kebabSegment(segment)).join("-")
}

/** Infer a leaf's yargs type from its default `value`, or its `explicitType` when `null`. */
function leafType(spec: OptionLeafSpec): OptionLeafType {
  return match(spec.value)
    .with(P.boolean, () => OptionLeafType.boolean)
    .with(P.number, () => OptionLeafType.number)
    .with(P.string, () => OptionLeafType.string)
    .otherwise(() =>
      asOption(spec.explicitType).getOrThrow(
        `option leaf with a null default needs an explicit type: ${spec.describe}`
      )
    )
}

/** Build one {@link OptionLeaf} from a spec + its resolved path. */
function toLeaf(spec: OptionLeafSpec, path: string[]): OptionLeaf {
  return {
    path,
    flag: toFlag(path),
    type: leafType(spec),
    value: spec.value,
    describe: spec.describe,
    required: spec.required,
    choices: spec.choices
  }
}

/**
 * Recursively flatten an option-shape descriptor into its leaves — the SINGLE
 * walk that drives flag registration ({@link applyClusterBuildOptionsArgs}) and
 * the reverse parse ({@link toClusterBuildOptions}). Nested objects recurse by
 * key; arrays recurse by numeric index; every {@link OptionLeafSpec} becomes one
 * {@link OptionLeaf}. An empty array yields zero leaves (empty-by-default arrays
 * — e.g. collateral — simply contribute no flags).
 *
 * @param node - The descriptor node to flatten (defaults to the whole shape).
 * @param path - The accumulated path segments (internal; starts empty).
 * @returns Every leaf under `node`, each with its path + kebab flag + type.
 */
export function flattenOptionLeaves(
  node: OptionShapeNode,
  path: string[] = []
): OptionLeaf[] {
  // Structural recursion over the (self-referential) OptionShapeNode union.
  // Plain narrowing guards are used deliberately here: routing this three-way
  // dispatch through `match(node)` makes ts-pattern instantiate the recursive
  // union to an excessive depth (TS2589). Each guard narrows a distinct kind.
  if (node instanceof OptionLeafSpec) {
    return [toLeaf(node, path)]
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, index) =>
      flattenOptionLeaves(child, [...path, String(index)])
    )
  }
  return Object.entries(node).flatMap(([key, child]) =>
    flattenOptionLeaves(child, [...path, key])
  )
}

/** `{ http, p2p }` nodeop port pair — both auto-picked unless overridden. */
function buildPortPairShape(label: string): OptionShapeObject {
  return {
    http: optionalLeaf(OptionLeafType.number, `${label} http listen port`),
    p2p: optionalLeaf(OptionLeafType.number, `${label} p2p listen port`)
  }
}

/** A single-port daemon's `{ address, port }` (kiod, anvil, debugging server). */
function buildDaemonShape(label: string): OptionShapeObject {
  return {
    address: optionalLeaf(OptionLeafType.string, `${label} bind address`),
    port: optionalLeaf(OptionLeafType.number, `${label} listen port`)
  }
}

/** The `bind` sub-tree; node-port arrays are sized from the topology counts. */
function buildBindShape(
  nodeCount: number,
  batchCount: number,
  underwriterCount: number
): OptionShapeObject {
  return {
    kiod: buildDaemonShape("kiod"),
    nodeop: {
      address: optionalLeaf(OptionLeafType.string, "nodeop bind address"),
      ports: {
        bios: buildPortPairShape("bios nodeop"),
        producers: range(nodeCount).map(index =>
          buildPortPairShape(`producer[${index}] nodeop`)
        ),
        batch: range(batchCount).map(index =>
          buildPortPairShape(`batch operator[${index}] nodeop`)
        ),
        underwriters: range(underwriterCount).map(index =>
          buildPortPairShape(`underwriter[${index}] nodeop`)
        )
      }
    },
    anvil: buildDaemonShape("anvil"),
    solana: {
      address: optionalLeaf(OptionLeafType.string, "solana bind address"),
      ports: {
        http: optionalLeaf(OptionLeafType.number, "solana RPC listen port"),
        faucet: optionalLeaf(
          OptionLeafType.number,
          "solana faucet listen port"
        ),
        gossip: optionalLeaf(
          OptionLeafType.number,
          "solana validator gossip listen port (--gossip-port)"
        )
      }
    },
    debuggingServer: buildDaemonShape("debugging server")
  }
}

/** The `logging` sub-tree — per-sink levels + the file format (enum-string leaves). */
function buildLoggingShape(): OptionShapeObject {
  return {
    levels: {
      console: leaf(Level.info, "console log level"),
      file: leaf(Level.debug, "file log level")
    },
    fileFormat: leaf(
      LogFileAppender.Format.jsonl,
      "log file format: text or jsonl"
    )
  }
}

/** The `report` sub-tree; `formats` is empty-by-default → no per-format flags. */
function buildReportShape(): OptionShapeObject {
  return {
    path: optionalLeaf(OptionLeafType.string, "report output directory"),
    basename: optionalLeaf(OptionLeafType.string, "report file basename"),
    formats: []
  }
}

/**
 * The canonical {@link ClusterBuildOptions} descriptor — one {@link
 * OptionLeafSpec} per leaf, at every depth. TS interfaces have no runtime shape,
 * so this concrete object IS the source the flag tree is derived from. Node-port
 * arrays are sized from the (caller-seeded or default) topology counts so the
 * per-node override flags exist; empty-by-default arrays (collateral) contribute
 * no flags.
 *
 * @param defaults - Caller option defaults; only the topology counts (used to
 *   size the bind arrays) are read here.
 * @returns The nested descriptor to flatten.
 */
export function buildOptionShape(
  defaults: ClusterBuildOptions
): OptionShapeObject {
  const {
    nodeCount = CliDefault.nodeCount,
    batchOperatorCount: batchCount = CliDefault.batchOperatorCount,
    underwriterCount = CliDefault.underwriterCount
  } = defaults
  return {
    // ── paths ──
    clusterPath: requiredLeaf(OptionLeafType.string, "cluster data directory"),
    buildPath: requiredLeaf(OptionLeafType.string, "wire-sysio build dir"),
    ethereumPath: requiredLeaf(OptionLeafType.string, "wire-ethereum repo"),
    solanaPath: requiredLeaf(OptionLeafType.string, "wire-solana repo"),
    force: leaf(
      false,
      "replace an existing cluster directory (required when --cluster-path already exists; refuses while its daemons are live)"
    ),
    // ── topology ──
    nodeCount: leaf(CliDefault.nodeCount, "producer node process count"),
    producerCount: leaf(CliDefault.producerCount, "producer account count"),
    batchOperatorCount: leaf(
      CliDefault.batchOperatorCount,
      "batch operator count — ODD and divisible by 3 (3, 9, 15, 21) unless --operators-per-epoch OR --batch-op-groups is given; max 26"
    ),
    underwriterCount: leaf(CliDefault.underwriterCount, "underwriter count"),
    // ── epoch ──
    epochDurationSec: leaf(
      CliDefault.epochDurationSec,
      "minimum epoch duration in seconds"
    ),
    operatorsPerEpoch: optionalLeaf(
      OptionLeafType.number,
      "batch-op group SIZE (operators_per_epoch); omit to derive from batchOperatorCount"
    ),
    batchOpGroups: optionalLeaf(
      OptionLeafType.number,
      "batch-op group COUNT (batch_op_groups); omit to derive from batchOperatorCount"
    ),
    epochRetentionEnvelopeLogCount: optionalLeaf(
      OptionLeafType.number,
      "epoch_retention_envelope_log_count; omit for the bootstrap default"
    ),
    warmupEpochs: optionalLeaf(
      OptionLeafType.number,
      "warmup epochs before the measured window"
    ),
    cooldownEpochs: optionalLeaf(
      OptionLeafType.number,
      "cooldown epochs after the measured window"
    ),
    // ── termination tuning ──
    terminateMaxConsecutiveMisses: optionalLeaf(
      OptionLeafType.number,
      "consecutive missed-delivery termination threshold"
    ),
    terminateMaxPercentMisses24h: optionalLeaf(
      OptionLeafType.number,
      "24h missed-delivery percentage termination threshold"
    ),
    terminateWindowMs: optionalLeaf(
      OptionLeafType.number,
      "termination evaluation window in ms"
    ),
    // ── network binding ──
    bindAll: leaf(false, "bind every daemon to 0.0.0.0 instead of loopback"),
    // ── mock data seeding (default false → external / real depots get no fake reserves) ──
    enableMockReserves: leaf(
      false,
      "seed the 8 mock (chain, token) PRIMARY reserves at bootstrap"
    ),
    bind: buildBindShape(nodeCount, batchCount, underwriterCount),
    bindConfig: optionalLeaf(
      OptionLeafType.string,
      "path to a BindConfig JSON (complete → used verbatim; partial → merged over resolved defaults)"
    ),
    // ── external outposts (bootstrap the depot against already-deployed remote outposts) ──
    externalOutpostConfig: optionalLeaf(
      OptionLeafType.string,
      "path to an ExternalOutpostConfig JSON (ETH + SOL outposts already run on real chains)"
    ),
    // ── distribution-claim bootstrap inputs ──
    ethereum: {
      bootstrapJsonFile: optionalLeaf(
        OptionLeafType.string,
        "path to the Ethereum prelaunch balance JSON imported into sysio.dclaim"
      )
    },
    solana: {
      bootstrapJsonFile: optionalLeaf(
        OptionLeafType.string,
        "path to the Solana prelaunch balance JSON imported into sysio.dclaim"
      )
    },
    // ── signature provider (how the cluster's own signing keys are handled) ──
    signatureProvider: {
      type: choicesLeaf(
        Object.values(SignatureProviderType),
        SignatureProviderType.KEY,
        "signature provider type: KEY (inline), SSM, or KIOD"
      )
    },
    // ── collateral (empty-by-default → no indexed flags) ──
    requiredProducerCollateral: [],
    requiredBatchOperatorCollateral: [],
    requiredUnderwriterCollateral: [],
    underwriterCollateral: [],
    // ── outputs ──
    logging: buildLoggingShape(),
    report: buildReportShape()
  }
}

/**
 * The `--cluster-path` / `-d` flag — named because a `--cluster-build-options-file`
 * document may also author `clusterPath`, and the two are mutually exclusive
 * (`ClusterConfigProvider.assertClusterPathSource`).
 */
export const ClusterPathFlag = "cluster-path"

/** yargs `-alias` for the highest-traffic flags (mirrors the historical CLI). */
const AliasByFlag: Record<string, string> = {
  [ClusterPathFlag]: "d",
  "node-count": "n",
  "producer-count": "p",
  "batch-operator-count": "b",
  "underwriter-count": "u"
}

/** A parsed-argv record — every yargs field arrives as `unknown`. */
type OptionArgv = Record<string, unknown>

/** Read one scalar leaf value out of a caller's `defaults` by dotted path, or `null`. */
function readDeep(
  source: ClusterBuildOptions,
  path: string[]
): OptionLeafValue {
  const found = path.reduce<unknown>(
    (node, segment) =>
      node != null && typeof node === "object"
        ? ((node as Record<string, unknown>)[segment] ?? null)
        : null,
    source
  )
  return match(found)
    .with(P.union(P.string, P.number, P.boolean), identity)
    .otherwise(() => null)
}

/** The yargs `.option(...)` config for one leaf: type + describe + seeded default + demand. */
function toYargsOption(
  optionLeaf: OptionLeaf,
  defaults: ClusterBuildOptions
): YargsOption {
  const seeded = readDeep(defaults, optionLeaf.path) ?? optionLeaf.value,
    option: YargsOption = {
      // OptionLeafType's identity values ARE yargs' `type` spellings — the
      // enum member is assignable to yargs' literal union directly.
      type: optionLeaf.type,
      describe: optionLeaf.describe,
      // yargs mandates `undefined` for "no default"; normalize `null` at the boundary.
      default: seeded ?? undefined,
      demandOption: optionLeaf.required && seeded == null,
      // conditional spread — `choices` / `alias` keys are absent when unset
      ...(optionLeaf.choices != null ? { choices: optionLeaf.choices } : {}),
      ...asOption(AliasByFlag[optionLeaf.flag])
        .map((alias): Partial<Pick<YargsOption, "alias">> => ({ alias }))
        .getOrElse({})
    }
  return option
}

/**
 * The `WIRE_*` environment variables seeding the shared path flags — the e2e
 * gate's uniform per-flow contract (`e2e-tests-no-per-flow-env-customization`)
 * and `scripts/run-flow.mjs` set exactly these. NOT an identity enum (the
 * values are external variable names), so a `const` lookup per the
 * string-enum-value-equals-key rule. NOTE the historical spelling
 * `WIRE_ETH_PATH` → `ethereumPath` — not a mechanical kebab mapping.
 */
export const PathEnvironmentVariableByOption = {
  clusterPath: "WIRE_CLUSTER_PATH",
  buildPath: "WIRE_BUILD_PATH",
  ethereumPath: "WIRE_ETH_PATH",
  solanaPath: "WIRE_SOLANA_PATH"
} as const satisfies Partial<Record<keyof ClusterBuildOptions, string>>

/**
 * Read the `WIRE_*` path variables into a {@link ClusterBuildOptions} layer —
 * absent / empty variables are omitted so they never mask another source.
 *
 * @param environment - The environment map (injectable for tests).
 * @returns The env-derived path options.
 */
export function environmentPathDefaults(
  environment: NodeJS.ProcessEnv = process.env
): ClusterBuildOptions {
  return Object.fromEntries(
    Object.entries(PathEnvironmentVariableByOption)
      .map(([option, variable]) => [option, environment[variable]])
      .filter(([, value]) => isString(value) && value.length > 0)
  ) as ClusterBuildOptions
}

/**
 * Add the shared {@link ClusterBuildOptions} flag surface to a yargs instance —
 * the SAME flags for the `wire-cluster-tool` CLI and every `flow-*` executable
 * (so a flow runs under the identical env, per
 * `e2e-tests-no-per-flow-env-customization`). Every leaf of `ClusterBuildOptions`
 * — at ANY nesting depth — becomes a `--kebab-path` flag (dotted path with each
 * camelCase segment kebab-cased, `.` → `-`; array leaves index numerically).
 * Flag defaults seed from the `WIRE_*` path variables
 * ({@link environmentPathDefaults} — per-invocation operator intent, highest)
 * then the caller's `defaults` (a flow's `Scenario.defaults`); a seeded leaf
 * becomes optional rather than required, and an explicit flag beats both. Every
 * generated flag carries a `describe`.
 *
 * @param yargs - The yargs instance to extend.
 * @param defaults - Per-scenario option defaults (paths / counts / epoch / …).
 * @param environment - The environment map (injectable for tests).
 * @returns The extended yargs instance.
 */
export function applyClusterBuildOptionsArgs(
  yargs: Argv,
  defaults: ClusterBuildOptions = {},
  environment: NodeJS.ProcessEnv = process.env
): Argv {
  const seededDefaults: ClusterBuildOptions = defaultsDeep(
    {},
    environmentPathDefaults(environment),
    defaults
  )
  const withShape = flattenOptionLeaves(buildOptionShape(seededDefaults)).reduce(
    (instance, optionLeaf) =>
      instance.option(
        optionLeaf.flag,
        toYargsOption(optionLeaf, seededDefaults)
      ),
    yargs
  )
  // These three live OUTSIDE the option shape: each payload is a JSON document
  // (object / file path), not a scalar leaf. Registering them here keeps
  // `.strict()` accepting them and `--help` listing them on every command that
  // shares this surface.
  return withShape
    .option(SignatureProviderSSMFlag, {
      type: "string",
      describe:
        "SSM publish settings as inline JSON ({awsSecretIdPattern, version?}) or a file path (required when --signature-provider-type SSM; the regions come from awsClusterNodeConfig)"
    })
    .option(ClusterBuildOptionsFileFlag, {
      type: "string",
      describe:
        "path to a ClusterBuildOptions JSON document (every option leaf + the collateral arrays + signatureProvider.ssm); explicit flags beat the file, the file beats WIRE_* env"
    })
    .option(AWSClusterNodeConfigFlag, {
      type: "string",
      describe:
        "path to an AWSClusterNodeConfig JSON file (the AWS account + every region secrets replicate to, plus its ssm settings)"
    })
}

// ── raw command-line reads (pre-parse — the builder needs these BEFORE yargs) ──

/**
 * Read a `--<flag> <value>` / `--<flag>=<value>` string option straight from a
 * RAW argv array, before yargs parses it. Needed because a flag whose value
 * seeds the OTHER flags' defaults (`--cluster-build-options-file`) has to be
 * known at builder time, which runs before any parse result exists.
 *
 * @param commandLine - The raw argument array (`process.argv.slice(2)`-shaped).
 * @param flag - The long flag name, without the leading `--`.
 * @returns The flag's value, or `null` when the flag is absent.
 */
export function readCommandLineFlag(
  commandLine: string[],
  flag: string
): string {
  const long = `--${flag}`,
    assigned = `${long}=`,
    index = commandLine.findIndex(
      argument => argument === long || argument.startsWith(assigned)
    )
  if (index < 0) {
    return null
  }
  const argument = commandLine[index]
  return argument.startsWith(assigned)
    ? argument.slice(assigned.length)
    : commandLine[index + 1]
}

/**
 * Whether a flag was passed EXPLICITLY on the raw command line — its long form
 * (`--flag`, `--flag=value`) or its registered short alias (`-d`, `-d=value`).
 * A yargs `default` (seeded from a file or the environment) is invisible here by
 * construction, which is exactly what a "who authored this value" check needs.
 *
 * @param commandLine - The raw argument array.
 * @param flag - The long flag name, without the leading `--`.
 * @returns `true` when the flag itself appears on the command line.
 */
export function hasCommandLineFlag(
  commandLine: string[],
  flag: string
): boolean {
  const alias = AliasByFlag[flag],
    forms = [`--${flag}`, ...(alias != null ? [`-${alias}`] : [])]
  return commandLine.some(argument =>
    forms.some(form => argument === form || argument.startsWith(`${form}=`))
  )
}

/** Read a flag off argv by its kebab form, falling back to yargs' camelCase alias. */
function readArg(argv: OptionArgv, flag: string): unknown {
  return argv[flag] ?? argv[camelCase(flag)] ?? null
}

/** Coerce a raw argv value to the leaf's declared type (argv arrives as `unknown`). */
function coerce(type: OptionLeafType, raw: unknown): OptionLeafValue {
  return match(type)
    .with(OptionLeafType.number, () => Number(raw))
    .with(OptionLeafType.boolean, () => Boolean(raw))
    .with(OptionLeafType.string, () => String(raw))
    .exhaustive()
}

/** The tree being re-nested from flat argv — an object or array of the same. */
type OptionTreeValue = OptionLeafValue | OptionTreeContainer
type OptionTreeContainer = OptionTreeValue[] | OptionTreeObject
interface OptionTreeObject {
  [key: string]: OptionTreeValue
}

/** True when a path segment is a numeric array index. */
const IndexSegmentPattern = /^\d+$/
function isIndexSegment(segment: string): boolean {
  return IndexSegmentPattern.test(segment)
}

/** Read a child by segment (arrays accept numeric-string keys uniformly). */
function childOf(
  node: OptionTreeContainer,
  segment: string
): OptionTreeValue {
  return (node as OptionTreeObject)[segment] ?? null
}

/** Write a child by segment (arrays accept numeric-string keys uniformly). */
function putChild(
  node: OptionTreeContainer,
  segment: string,
  value: OptionTreeValue
): void {
  ;(node as OptionTreeObject)[segment] = value
}

/**
 * Re-nest one flat leaf value into `root` at its dotted path, creating each
 * intermediate container as an array when the NEXT segment is a numeric index,
 * else an object. The exact inverse of {@link flattenOptionLeaves}' path walk.
 * Every leaf path comes from `buildOptionShape` (the `ClusterBuildOptions`
 * mirror), so the assembled tree IS the options object — the dynamic-path
 * indexing view below is the ONE typed boundary of that assembly.
 */
function setDeep(
  root: ClusterBuildOptions,
  path: string[],
  value: OptionLeafValue
): void {
  const tree: OptionTreeObject = root as OptionTreeObject
  const lastIndex = path.length - 1,
    container = path
      .slice(0, lastIndex)
      .reduce<OptionTreeContainer>((node, segment, depth) => {
        const child =
          childOf(node, segment) ?? (isIndexSegment(path[depth + 1]) ? [] : {})
        putChild(node, segment, child)
        return child as OptionTreeContainer
      }, tree)
  putChild(container, path[lastIndex], value)
}

/** The `ClusterBuildOptions` path leaves resolved absolute so any cwd resolves the same roots. */
const PathOptionKeys = [
  "buildPath",
  "clusterPath",
  "ethereumPath",
  "solanaPath"
] as const

/** A `ClusterBuildOptions` member holding a filesystem path. */
type PathOptionKey = (typeof PathOptionKeys)[number]

/** Resolve every present path leaf to an absolute path, in-place. */
function absolutePaths(options: ClusterBuildOptions): ClusterBuildOptions {
  PathOptionKeys.forEach(key => absolutePathOption(options, key))
  return options
}

/** Resolve one path member absolute (typed same-key read → write). */
function absolutePathOption<K extends PathOptionKey>(
  options: ClusterBuildOptions,
  key: K
): void {
  options[key] = asOption(options[key])
    .filter(isString)
    .map(value => Path.resolve(value))
    .getOrElse(options[key])
}

/** Read the topology counts back off argv so the reverse walk sizes bind arrays identically. */
function countsFromArgv(argv: OptionArgv): ClusterBuildOptions {
  const count = (flag: string): number | undefined =>
    asOption(readArg(argv, flag))
      .filter(raw => raw != null)
      .map(raw => Number(raw))
      .filter(Number.isFinite)
      .getOrUndefined()
  return {
    nodeCount: count("node-count"),
    batchOperatorCount: count("batch-operator-count"),
    underwriterCount: count("underwriter-count")
  }
}

/**
 * Map a parsed argv (from {@link applyClusterBuildOptionsArgs}) back into nested
 * {@link ClusterBuildOptions} — the exact inverse of registration. The shared
 * {@link flattenOptionLeaves} walk supplies the same leaf set (bind arrays sized
 * from argv's own counts); each present flag is coerced to its type and
 * re-nested at its dotted path. Only flags actually supplied (or seeded with a
 * default) are set, so unset bind ports stay absent for `BindConfig` to
 * auto-pick. Path leaves are absolutized so a flow run from any cwd resolves the
 * same cluster / build / outpost roots.
 *
 * The NON-FLAG leaves ({@link NonFlagOptionKeys} — the collateral object-arrays
 * `buildOptionShape` declares flag-less) can't ride argv; they carry over from
 * `defaults` verbatim (e.g. a `FlowScenario.defaults.requiredBatchOperatorCollateral`).
 *
 * @param argv - The parsed yargs result (fields arrive as `unknown`).
 * @param defaults - Caller defaults supplying the non-flag leaves.
 * @returns The resolved, nested cluster build options.
 */
export function toClusterBuildOptions(
  argv: OptionArgv,
  defaults: ClusterBuildOptions = {}
): ClusterBuildOptions {
  // `{}` IS a valid ClusterBuildOptions (every member is optional) — no cast.
  const options: ClusterBuildOptions = {}
  flattenOptionLeaves(buildOptionShape(countsFromArgv(argv))).forEach(
    optionLeaf => {
      asOption(readArg(argv, optionLeaf.flag))
        .filter(raw => raw != null)
        .map(raw => coerce(optionLeaf.type, raw))
        .match({
          Some: value => setDeep(options, optionLeaf.path, value),
          None: () => undefined
        })
    }
  )
  NonFlagOptionKeys.forEach(key => carryNonFlagOption(options, defaults, key))
  return absolutePaths(options)
}

/** The one non-flag member whose element type is `ChainTokenAmount[]`, not `CollateralRequirement`. */
const UnderwriterCollateralKey = "underwriterCollateral" as const

/**
 * `ClusterBuildOptions` members with NO flag representation (object-arrays —
 * `buildOptionShape` declares them empty). They flow from a caller's `defaults`
 * (e.g. a `FlowScenario.defaults`, or a `--cluster-build-options-file`
 * document) straight into the resolved options.
 */
const NonFlagOptionKeys = [
  "requiredProducerCollateral",
  "requiredBatchOperatorCollateral",
  "requiredUnderwriterCollateral",
  UnderwriterCollateralKey
] as const satisfies ReadonlyArray<keyof ClusterBuildOptions>

/** A `ClusterBuildOptions` member with no flag representation. */
type NonFlagOptionKey = (typeof NonFlagOptionKeys)[number]

/** Carry one non-flag member over from `defaults` (typed same-key read → write). */
function carryNonFlagOption<K extends NonFlagOptionKey>(
  options: ClusterBuildOptions,
  defaults: ClusterBuildOptions,
  key: K
): void {
  if (defaults[key] != null) {
    options[key] = defaults[key]
  }
}

// ── `--cluster-build-options-file` (a whole ClusterBuildOptions document) ─────

/** The out-of-shape member a build-options document MAY carry (validated by its own codec). */
const SignatureProviderSSMDocumentPath = "signatureProvider.ssm"

/** The member a build-options document may NOT carry — it has its own flag. */
const AWSClusterNodeConfigDocumentKey =
  "awsClusterNodeConfig" as const satisfies keyof ClusterBuildOptions

/** The topology counts a document may set; they size the `bind` arrays of its own shape. */
const TopologyCountKeys = [
  "nodeCount",
  "batchOperatorCount",
  "underwriterCount"
] as const satisfies ReadonlyArray<keyof ClusterBuildOptions>

/** A topology-count member of a build-options document. */
type TopologyCountKey = (typeof TopologyCountKeys)[number]

/** Prefix every document diagnostic with the flag + the file it came from. */
function documentLabel(file: string): string {
  return `--${ClusterBuildOptionsFileFlag} ${file}`
}

/** Human label for a document path (the root has no segments). */
function documentPathLabel(path: string[]): string {
  return path.length === 0 ? "(root)" : path.join(".")
}

/** True when `key` is one of the flag-less object-array members. */
function isNonFlagOptionKey(key: string): key is NonFlagOptionKey {
  return (NonFlagOptionKeys as ReadonlyArray<string>).includes(key)
}

/** The {@link OptionLeafType} of a scalar document value. */
function documentLeafType(value: OptionLeafValue): OptionLeafType {
  return match(value)
    .with(P.boolean, () => OptionLeafType.boolean)
    .with(P.number, () => OptionLeafType.number)
    .with(P.string, () => OptionLeafType.string)
    .exhaustive()
}

/**
 * Validate one scalar document value against its {@link OptionLeaf} spec — the
 * yargs primitive type, and `choices` membership when the leaf constrains it.
 */
function assertDocumentLeafValue(
  optionLeaf: OptionLeaf,
  value: unknown,
  file: string
): OptionLeafValue {
  const scalar = match(value)
    .with(P.union(P.string, P.number, P.boolean), identity)
    .otherwise(() =>
      Assert.fail(
        `${documentLabel(file)}: "${optionLeaf.path.join(".")}" must be a ${optionLeaf.type}, not an object/array/null`
      )
    )
  Assert.ok(
    documentLeafType(scalar) === optionLeaf.type,
    `${documentLabel(file)}: "${optionLeaf.path.join(".")}" must be a ${optionLeaf.type} (got ${documentLeafType(scalar)} ${JSON.stringify(scalar)})`
  )
  Assert.ok(
    optionLeaf.choices == null ||
      optionLeaf.choices.includes(String(scalar)),
    `${documentLabel(file)}: "${optionLeaf.path.join(".")}" must be one of ${optionLeaf.choices?.join(" | ")} (got ${JSON.stringify(scalar)})`
  )
  return scalar
}

/** Decode one flag-less object-array member through its shared-schema codec. */
function decodeNonFlagOption(
  key: NonFlagOptionKey,
  value: unknown
): CollateralRequirement[] | ChainTokenAmount[][] {
  const text = JSON.stringify(value)
  return match(key)
    .with(UnderwriterCollateralKey, () =>
      underwriterCollateralCodec.deserialize(text)
    )
    .otherwise(() => collateralRequirementsCodec.deserialize(text))
}

/**
 * Decode + assign one flag-less object-array member. The two codecs mirror the
 * two member shapes exactly, but TS cannot correlate the runtime dispatch inside
 * {@link decodeNonFlagOption} with `K` — so the ONE cast lives here, at the
 * dispatch boundary.
 */
function appendNonFlagOption<K extends NonFlagOptionKey>(
  options: ClusterBuildOptions,
  key: K,
  value: unknown
): void {
  options[key] = decodeNonFlagOption(key, value) as ClusterBuildOptions[K]
}

/**
 * Read + validate the three topology counts a document may set — they size the
 * `bind` node-port arrays of the very shape the rest of the document is
 * validated against, so they are checked BEFORE the shape is built.
 */
function assertTopologyCounts(
  document: Record<string, unknown>,
  file: string
): ClusterBuildOptions {
  const counts: ClusterBuildOptions = {}
  TopologyCountKeys.forEach(key =>
    appendTopologyCount(counts, key, document[key], file)
  )
  return counts
}

/** Validate + assign ONE topology count (typed same-key write, as `carryNonFlagOption`). */
function appendTopologyCount<K extends TopologyCountKey>(
  counts: ClusterBuildOptions,
  key: K,
  value: unknown,
  file: string
): void {
  if (value == null) {
    return
  }
  Assert.ok(
    typeof value === "number" && Number.isInteger(value) && value >= 0,
    `${documentLabel(file)}: "${key}" must be a non-negative integer (got ${JSON.stringify(value)})`
  )
  counts[key] = value
}

/** Every PROPER prefix of a leaf path — the branch paths a document may descend through. */
function documentBranchPaths(leaves: OptionLeaf[]): ReadonlySet<string> {
  return new Set(
    leaves.flatMap(optionLeaf =>
      optionLeaf.path
        .slice(0, -1)
        .map((_segment, depth) => optionLeaf.path.slice(0, depth + 1).join("."))
    )
  )
}

/** The walk state shared by every {@link appendDocumentNode} recursion. */
interface DocumentWalk {
  /** Every scalar leaf of the document's own shape, by dotted path. */
  leafByPath: ReadonlyMap<string, OptionLeaf>
  /** Every branch path those leaves descend through. */
  branchPaths: ReadonlySet<string>
  /** The resolved file path, for diagnostics. */
  file: string
}

/**
 * Walk one document node, appending it to `options`. A path that names a scalar
 * leaf is type-checked and re-nested; the flag-less members and
 * `signatureProvider.ssm` are decoded whole through their codecs; any other path
 * must be a known branch — otherwise the walk fails naming the offending path.
 */
function appendDocumentNode(
  node: unknown,
  path: string[],
  walk: DocumentWalk,
  options: ClusterBuildOptions
): void {
  const dotted = documentPathLabel(path),
    [firstSegment] = path,
    { leafByPath, branchPaths, file } = walk
  Assert.ok(
    dotted !== AWSClusterNodeConfigDocumentKey,
    `${documentLabel(file)}: "${AWSClusterNodeConfigDocumentKey}" is not part of a build-options document — pass it with --${AWSClusterNodeConfigFlag} <file>`
  )
  const optionLeaf = leafByPath.get(dotted)
  if (optionLeaf != null) {
    setDeep(
      options,
      optionLeaf.path,
      assertDocumentLeafValue(optionLeaf, node, file)
    )
    return
  }
  if (path.length === 1 && isNonFlagOptionKey(firstSegment)) {
    appendNonFlagOption(options, firstSegment, node)
    return
  }
  if (dotted === SignatureProviderSSMDocumentPath) {
    options.signatureProvider = {
      ...(options.signatureProvider ?? {}),
      ssm: ssmOptionsCodec.deserialize(JSON.stringify(node))
    }
    return
  }
  Assert.ok(
    path.length === 0 || branchPaths.has(dotted),
    `${documentLabel(file)}: unknown option "${dotted}"`
  )
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      appendDocumentNode(child, [...path, String(index)], walk, options)
    )
    return
  }
  Assert.ok(
    isPlainObject(node),
    `${documentLabel(file)}: "${dotted}" must be an object (it holds nested options)`
  )
  Object.entries(node as Record<string, unknown>).forEach(([key, child]) =>
    appendDocumentNode(child, [...path, key], walk, options)
  )
}

/**
 * Validate a parsed build-options document against the SAME
 * {@link buildOptionShape} descriptor the flags are generated from — the one
 * runtime source of truth for what a `ClusterBuildOptions` leaf is (there is no
 * second zod mirror of the interface). Unknown keys and type mismatches are hard
 * errors naming the offending dotted path.
 *
 * @param document - The parsed JSON document.
 * @param file - The resolved file path (diagnostics only).
 * @returns The document as nested {@link ClusterBuildOptions}.
 */
export function toClusterBuildOptionsDocument(
  document: unknown,
  file: string
): ClusterBuildOptions {
  Assert.ok(
    isPlainObject(document),
    `${documentLabel(file)}: the document root must be a JSON object`
  )
  const root = document as Record<string, unknown>,
    leaves = flattenOptionLeaves(
      buildOptionShape(assertTopologyCounts(root, file))
    ),
    walk: DocumentWalk = {
      leafByPath: new Map(
        leaves.map(optionLeaf => [optionLeaf.path.join("."), optionLeaf])
      ),
      branchPaths: documentBranchPaths(leaves),
      file
    },
    options: ClusterBuildOptions = {}
  appendDocumentNode(root, [], walk, options)
  return options
}

/**
 * Load + validate a `--cluster-build-options-file` document.
 *
 * @param file - Path to the JSON document (resolved absolute).
 * @returns The validated, nested build options.
 * @throws When the file is not valid JSON, or carries an unknown / wrongly-typed option.
 */
export function loadClusterBuildOptionsFile(file: string): ClusterBuildOptions {
  const resolved = Path.resolve(file),
    document = Either.try(
      () => JSON.parse(Fs.readFileSync(resolved, "utf-8")) as unknown
    )
      .ifLeft(error => {
        throw new NestedError(
          `${documentLabel(resolved)}: could not be read as JSON`,
          { cause: error, context: { file: resolved } }
        )
      })
      .getOrThrow()
  return toClusterBuildOptionsDocument(document, resolved)
}

/**
 * Load the `--cluster-build-options-file` document named on a RAW command line,
 * before yargs parses it (the builder seeds every other flag's default from it).
 *
 * @param commandLine - The raw argument array (`process.argv.slice(2)`-shaped).
 * @returns The validated build options, or `null` when the flag is absent.
 */
export function toClusterBuildOptionsFile(
  commandLine: string[]
): ClusterBuildOptions {
  const file = readCommandLineFlag(commandLine, ClusterBuildOptionsFileFlag)
  if (!isString(file) || file.trim().length === 0) {
    return null
  }
  return loadClusterBuildOptionsFile(file.trim())
}

/**
 * Parse the dedicated `--signature-provider-ssm` flag — inline JSON (leading
 * `{`) or a file path — into {@link AWSSSMSignatureProviderOptions}, or `null`
 * when the flag is absent.
 *
 * @param argv - The parsed yargs result.
 * @returns The SSM options, or `null`.
 */
export function toAWSSSMSignatureProviderOptions(
  argv: OptionArgv
): AWSSSMSignatureProviderOptions {
  const raw = readArg(argv, SignatureProviderSSMFlag)
  if (!isString(raw) || raw.trim().length === 0) {
    return null
  }
  const text = raw.trim(),
    json = text.startsWith("{")
      ? text
      : Fs.readFileSync(Path.resolve(text), "utf-8")
  return ssmOptionsCodec.deserialize(json)
}

/** Re-validate SSM options arriving from a source other than the flag, through the ONE codec. */
function assertSSMOptions(
  ssm: AWSSSMSignatureProviderOptions,
  source: string
): AWSSSMSignatureProviderOptions {
  if (ssm != null) {
    Assert.ok(
      ssmOptionsCodec.check(ssm),
      `${source}: invalid SSM settings (awsSecretIdPattern is required)`
    )
  }
  return ssm
}

/**
 * Merge SSM publish settings into `options.signatureProvider` (called after
 * {@link toClusterBuildOptions}) — the single create-side hook shared by
 * `CreateCommand` and `FlowCLI`. Precedence: the `--signature-provider-ssm`
 * flag > the `--cluster-build-options-file` document's `signatureProvider.ssm` >
 * the `--aws-cluster-node-config` file's own `ssm`. All three are validated by
 * the ONE {@link AWSSSMSignatureProviderOptionsSchema} codec. A no-op when no
 * source carries settings.
 *
 * @param options - The resolved build options (mutated + returned).
 * @param argv - The parsed yargs result.
 * @param fileOptions - The `--cluster-build-options-file` document, when one was loaded.
 * @returns `options`, with `signatureProvider.ssm` filled when supplied.
 */
export function mergeSignatureProviderSSM(
  options: ClusterBuildOptions,
  argv: OptionArgv,
  fileOptions: ClusterBuildOptions = {}
): ClusterBuildOptions {
  const ssm =
    toAWSSSMSignatureProviderOptions(argv) ??
    assertSSMOptions(
      fileOptions?.signatureProvider?.ssm,
      `${SignatureProviderSSMDocumentPath} in --${ClusterBuildOptionsFileFlag}`
    ) ??
    assertSSMOptions(
      options.awsClusterNodeConfig?.ssm,
      `ssm in --${AWSClusterNodeConfigFlag}`
    )
  if (ssm != null) {
    options.signatureProvider = { ...(options.signatureProvider ?? {}), ssm }
  }
  return options
}

/**
 * Parse the dedicated `--aws-cluster-node-config` flag — a path to an
 * `AWSClusterNodeConfig` JSON file — or `null` when the flag is absent.
 *
 * @param argv - The parsed yargs result.
 * @returns The validated AWS placement, or `null`.
 */
export function toAWSClusterNodeConfig(
  argv: OptionArgv
): AWSClusterNodeConfig {
  const raw = readArg(argv, AWSClusterNodeConfigFlag)
  if (!isString(raw) || raw.trim().length === 0) {
    return null
  }
  return AWSClusterNodeConfigSchemaCodec.deserialize(
    Fs.readFileSync(Path.resolve(raw.trim()), "utf-8")
  )
}

/**
 * Merge the `--aws-cluster-node-config` file into `options.awsClusterNodeConfig`.
 * Runs BEFORE {@link mergeSignatureProviderSSM} so that merge can see the file's
 * own `ssm` as its lowest-precedence source. A no-op when the flag is absent.
 *
 * @param options - The resolved build options (mutated + returned).
 * @param argv - The parsed yargs result.
 * @returns `options`, with `awsClusterNodeConfig` filled when supplied.
 */
export function mergeAWSClusterNodeConfig(
  options: ClusterBuildOptions,
  argv: OptionArgv
): ClusterBuildOptions {
  const awsClusterNodeConfig = toAWSClusterNodeConfig(argv)
  if (awsClusterNodeConfig != null) {
    options.awsClusterNodeConfig = awsClusterNodeConfig
  }
  return options
}
