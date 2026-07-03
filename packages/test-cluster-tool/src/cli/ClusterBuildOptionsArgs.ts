import Path from "node:path"
import { asOption } from "@3fv/prelude-ts"
import { isString, Level } from "@wireio/shared"
import { camelCase, defaultsDeep, range } from "lodash"
import { match, P } from "ts-pattern"
import type { Argv, Options as YargsOption } from "yargs"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { LogFileAppender } from "../logging/LogFileAppender.js"

/**
 * CLI-layer defaults for the {@link ClusterBuildOptions} topology / epoch leaves
 * — the values the `wire-test-cluster` CLI and every `flow-*` executable have
 * always used (a minimal single-node test cluster on a 60s epoch). These are the
 * flag defaults; a caller's `defaults` (a flow's `Scenario.defaults`) or an
 * explicit flag overrides them.
 *
 * NOTE: these are intentionally the *CLI* defaults and are distinct from
 * `ClusterConfig.Default*` (the resolve-time fallbacks used when an option is
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
    readonly explicitType: OptionLeafType | null = null
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
    required: spec.required
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
        faucet: optionalLeaf(OptionLeafType.number, "solana faucet listen port")
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
  const nodeCount = defaults.nodeCount ?? CliDefault.nodeCount,
    batchCount = defaults.batchOperatorCount ?? CliDefault.batchOperatorCount,
    underwriterCount = defaults.underwriterCount ?? CliDefault.underwriterCount
  return {
    // ── paths ──
    clusterPath: requiredLeaf(OptionLeafType.string, "cluster data directory"),
    buildPath: requiredLeaf(OptionLeafType.string, "wire-sysio build dir"),
    ethereumPath: requiredLeaf(OptionLeafType.string, "wire-ethereum repo"),
    solanaPath: requiredLeaf(OptionLeafType.string, "wire-solana repo"),
    clusterConfigPath: optionalLeaf(
      OptionLeafType.string,
      "explicit cluster-config.json path"
    ),
    force: leaf(false, "overwrite an existing cluster directory"),
    // ── topology ──
    nodeCount: leaf(CliDefault.nodeCount, "producer node process count"),
    producerCount: leaf(CliDefault.producerCount, "producer account count"),
    batchOperatorCount: leaf(
      CliDefault.batchOperatorCount,
      "batch operator count"
    ),
    underwriterCount: leaf(CliDefault.underwriterCount, "underwriter count"),
    // ── epoch ──
    epochDurationSec: leaf(
      CliDefault.epochDurationSec,
      "minimum epoch duration in seconds"
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
    bind: buildBindShape(nodeCount, batchCount, underwriterCount),
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

/** yargs `-alias` for the highest-traffic flags (mirrors the historical CLI). */
const AliasByFlag: Record<string, string> = {
  "cluster-path": "d",
  "node-count": "n",
  "producer-count": "p",
  "batch-operator-count": "b",
  "underwriter-count": "u"
}

/** The yargs `type` union — the wire spelling behind each {@link OptionLeafType}. */
type YargsPrimitiveType = "string" | "number" | "boolean"

/** Map a typed {@link OptionLeafType} to yargs' `type` string (enum-first, no cast). */
function yargsType(type: OptionLeafType): YargsPrimitiveType {
  return match(type)
    .with(OptionLeafType.string, () => "string" as const)
    .with(OptionLeafType.number, () => "number" as const)
    .with(OptionLeafType.boolean, () => "boolean" as const)
    .exhaustive()
}

/** A parsed-argv record — every yargs field arrives as `unknown`. */
type OptionArgv = Record<string, unknown>

/** Read one scalar leaf value out of a caller's `defaults` by dotted path, or `null`. */
function readDeep(
  source: ClusterBuildOptions,
  path: string[]
): OptionLeafValue | null {
  const found = path.reduce<unknown>(
    (node, segment) =>
      node != null && typeof node === "object"
        ? ((node as Record<string, unknown>)[segment] ?? null)
        : null,
    source
  )
  return match(found)
    .with(P.union(P.string, P.number, P.boolean), scalar => scalar)
    .otherwise(() => null)
}

/** The yargs `.option(...)` config for one leaf: type + describe + seeded default + demand. */
function toYargsOption(
  optionLeaf: OptionLeaf,
  defaults: ClusterBuildOptions
): YargsOption {
  const seeded = readDeep(defaults, optionLeaf.path) ?? optionLeaf.value,
    option: YargsOption = {
      type: yargsType(optionLeaf.type),
      describe: optionLeaf.describe,
      // yargs mandates `undefined` for "no default"; normalize `null` at the boundary.
      default: seeded ?? undefined,
      demandOption: optionLeaf.required && seeded == null,
      // conditional spread — the `alias` KEY itself is absent for unaliased flags
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
 * the SAME flags for the `wire-test-cluster` CLI and every `flow-*` executable
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
  return flattenOptionLeaves(buildOptionShape(seededDefaults)).reduce(
    (instance, optionLeaf) =>
      instance.option(optionLeaf.flag, toYargsOption(optionLeaf, seededDefaults)),
    yargs
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
): OptionTreeValue | null {
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
  "solanaPath",
  "clusterConfigPath"
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

/**
 * `ClusterBuildOptions` members with NO flag representation (object-arrays —
 * `buildOptionShape` declares them empty). They flow from a caller's `defaults`
 * (e.g. a `FlowScenario.defaults`) straight into the resolved options.
 */
const NonFlagOptionKeys = [
  "requiredProducerCollateral",
  "requiredBatchOperatorCollateral",
  "requiredUnderwriterCollateral",
  "underwriterCollateral"
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
