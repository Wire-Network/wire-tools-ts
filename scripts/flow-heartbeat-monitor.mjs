#!/usr/bin/env node
/**
 * Flow-run heartbeat monitor — the standing, executable implementation of the
 * cluster-state active-probing rule
 * (`wire-platform-manifest/.claude/rules/cluster-state-active-probing.md`).
 *
 * Watches ONE running flow (a `wire-test-cluster` / flow run driving a cluster
 * at `--cluster-path`) and, every `--interval-seconds`, executes ALL six probes
 * from the rule, printing ONE line-oriented, flushed heartbeat on stdout:
 *
 *   HB t=<s> head=<n> epoch=<n> env=<n> opp=<total> Δ=<delta> dirs: D>E=<n> E>D=<n> D>S=<n> S>D=<n> acts=[...] fatal=<n>(+<d>) noise=<n>(+<d>)
 *
 * plus `NOISE-TAIL:` / `FAIL-TAIL:` quote lines whenever those deltas are
 * positive. Everything derivable derives from `<cluster-path>/cluster-config.json`
 * once it appears: `executables.clio` (the resolved clio binary) and the URL
 * from `bind.nodeop.ports.producers[0].http` (NEVER bios — its port dies after
 * the Phase 8 producer handoff). Before the config exists the monitor emits
 * `HB t=<s> (pre-config)` and keeps going.
 *
 * The six probes, per beat:
 *   1. chain liveness            — `clio get info` → head_block_num
 *   2. operators table           — `sysio.opreg::operators` (v6 `-S` scope, fields under `.value`)
 *   3. epoch state singleton     — `sysio.epoch::epochstate` → current_epoch_index
 *   4. msgch outbound envelopes  — `sysio.msgch::envelopes` row count
 *   5. opp-debugging artifacts   — total + per-direction `.metadata` counts + delta
 *   6. aggregate cluster log     — action-receipt top-3 + the TWO failure classes:
 *      FATAL (plugin/execution signatures that stop OPP circulation — bail on
 *      persistent growth) and NOISE (chain `assertion failure` gate rejections —
 *      counted + quoted, NEVER a bail).
 *
 * The bails (print `BAIL: <reason>`, SIGINT the watched flow, exit 1):
 *   - bootstrap never completes — epoch still null/0 past the deadline since first liveness
 *   - epoch stall — same epoch as the previous beat AND still unchanged after a re-probe
 *   - opp-debugging zero delta on ANY beat once epoch >= 1 (first occurrence)
 *   - one direction frozen for 2 consecutive beats while the others advance
 *     (only after all four directions have a non-zero baseline)
 *   - FATAL count growing across 2 consecutive beats
 *
 * Exits 0 with a `FLOW-EXITED` line when the watched flow process disappears.
 *
 * Usage:
 *   node scripts/flow-heartbeat-monitor.mjs --cluster-path <cluster> [options]
 *   (run `--help` for the full option list and a pairing example)
 */

import { argv, chalk, echo, fs, glob, path, $, sleep } from "zx"

// ---------------------------------------------------------------------------
// Constants — tuning knobs + probe surface
// ---------------------------------------------------------------------------

/**
 * Seconds between heartbeats. Raising it slows detection of every bail;
 * lowering it below the epoch duration makes zero-delta beats normal on a
 * HEALTHY cluster (the zero-delta bail assumes interval > epoch duration).
 * Overridable via `--interval-seconds`.
 */
const DefaultIntervalSeconds = 90

/**
 * The cluster's configured epoch duration. Scales the bootstrap-deadline bail
 * (`max(BootstrapDeadlineFloorSeconds, 3 × this)`) and labels the epoch-stall
 * bail. Overridable via `--epoch-duration-seconds`.
 */
const DefaultEpochDurationSeconds = 60

/**
 * Floor (seconds of chain liveness with epoch still null/0) for the
 * bootstrap-never-completed bail. Raising it tolerates slower deploy phases;
 * lowering it risks bailing on a healthy-but-slow bootstrap.
 */
const BootstrapDeadlineFloorSeconds = 300

/**
 * Delay before the epoch-stall re-probe. A same-epoch heartbeat at 60s epochs
 * is the fatal signal, but consensus latency makes the effective cadence
 * ~90–105s — re-probe once after this delay and bail only if STILL unchanged
 * (a true stall = dead cluster). Raising it delays the stall bail; lowering it
 * re-introduces cadence-jitter false positives.
 */
const EpochStallReprobeDelaySeconds = 45

/**
 * Consecutive frozen beats (a direction's count unchanged while the total
 * advances) before the direction-plateau bail. Evaluated only once EVERY
 * direction has a non-zero baseline; lowering to 1 flags the normal
 * post-baseline ramp as a plateau.
 */
const DirectionFreezeBailStreak = 2

/**
 * Consecutive FATAL-count-growth beats before the failure-signature bail.
 * One-off transients (nonce retries, momentary table-read races) occur in
 * PASSING runs; persistent plugin breakage grows every cycle. Lowering to 1
 * re-introduces the transient false-positive bails this streak exists to stop.
 */
const FatalGrowthBailStreak = 2

/**
 * Per-clio-probe timeout. Prevents a wedged HTTP port from hanging the whole
 * monitor; a timed-out probe reads as `?` on the heartbeat line and the loop
 * continues.
 */
const ProbeTimeout = "15s"

/** Max characters quoted from the last NOISE line (keeps NOISE-TAIL one-line). */
const NoiseTailMaxLength = 120

/** FATAL lines quoted by FAIL-TAIL (rule self-check item 3: at least the last 2). */
const FatalTailLines = 2

/** Action receipts carried on the heartbeat line (`acts=[...]`, most frequent first). */
const TopActionReceipts = 3

/** Row limit for the operators / envelopes probes — the envelope count caps here. */
const TableQueryLimit = 50

/** The four OPP directions in heartbeat-line order, with their short labels. */
const OppDirections = [
  { name: "DEPOT_OUTPOST_ETHEREUM", short: "D>E" },
  { name: "OUTPOST_ETHEREUM_DEPOT", short: "E>D" },
  { name: "DEPOT_OUTPOST_SOLANA", short: "D>S" },
  { name: "OUTPOST_SOLANA_DEPOT", short: "S>D" }
]

// Failure classing (probe 6) — TWO classes, per the probing rule:
//   FATAL — plugin-layer / execution failures that stop OPP circulation; the
//   monitor bails on their PERSISTENT growth.
//   NOISE — chain `assertion failure` rejections: the depot's own gates
//   bouncing retrying/unscheduled crankers (duplicate deliver, stale nonce,
//   not-in-active-group, ...). Counted + quoted, NEVER a bail — the liveness
//   probes (epoch advance, opp delta, per-direction growth) are the gates.

/**
 * FATAL signatures (ERE): chain-execution + WIRE plugin-layer failures.
 * Narrowing it misses host-plugin failure modes (rule self-check item 9).
 */
const FatalSignaturePattern =
  "panicked|InstructionError|Program .* failed|execution reverted|custom program error: 0x|Contract Table Query Exception|Parse Error \\([0-9]+\\)|table read threw|error.*batch_operator:|error.*underwriter:|error.*outpost_(ethereum|solana)_client:"

/**
 * `TRX_TRACE` / `log_trx_results` JSON payloads — echo wrappers of the message
 * lines they carry. Excluded from both failure classes AND from the NOISE tail.
 */
const TrxEchoExcludePattern = "TRX_TRACE|log_trx_results"

/**
 * Every echo wrapper excluded from failure COUNTING: the TRX payload echoes
 * plus the net_plugin `signaled NACK` / `bad packed_transaction` summaries
 * (redundant wrappers of the lines they echo).
 */
const EchoWrapperExcludePattern = `${TrxEchoExcludePattern}|signaled NACK|bad packed_transaction`

/**
 * Outpost registry-sync lag rejections — self-healing gate bounces, NOISE not
 * FATAL. An operator flips ACTIVE on the depot mid-epoch; the outpost only
 * learns via the NEXT envelope's OPERATORS attestation (1–2 epochs), and until
 * that dispatches the underwriter plugin's commit retries bounce off the
 * outpost's status gate: SOL opp-outpost `0x1795` (OperatorNotActive), ETH
 * `OPP_NotActiveOperator`. Forensically verified (2026-07-04,
 * flow-swap-from-wire): the epoch-2 envelope carried ACTIVE and dispatched 24s
 * after the first bounce — the ~5s retry loop heals on the next attempt, so
 * bailing on growth here kills a healthy flow. The liveness probes (epoch
 * advance, opp delta, per-direction growth) remain the bail gates.
 */
const RegistrySyncLagPattern =
  "custom program error: 0x1795|OPP_NotActiveOperator"

/**
 * FATAL exclusions: the echo wrappers PLUS `sysio_assert_message` — a
 * plugin-tagged line whose payload is a chain assertion is the plugin
 * NARRATING chain noise (its push bounced off a depot gate): NOISE, not a
 * plugin failure. Removing this exclusion re-creates the false-positive bails
 * on healthy 9-operator clusters. Registry-sync lag bounces are excluded for
 * the same reason (see {@link RegistrySyncLagPattern}).
 */
const FatalExcludePattern = `${EchoWrapperExcludePattern}|sysio_assert_message|${RegistrySyncLagPattern}`

/** NOISE signatures (ERE): chain assertion-failure gate rejections + outpost
 *  registry-sync lag bounces (counted + quoted, never a bail). */
const NoiseSignaturePattern = `assertion failure|${RegistrySyncLagPattern}`

/** The line shapes the NOISE tail quotes (they carry the actual reason). */
const NoiseTailSourcePattern = `assertion failure with message|${RegistrySyncLagPattern}`

/** Action-receipt shape in the aggregate log (`sysio.<contract>::<action>`). */
const ActionReceiptPattern = "sysio\\.[a-z]+::[a-z]+"

// Depot accounts / tables probed each beat (v6 form: `clio get table <code> <table> -S <scope>`).
const SysioEpochAccount = "sysio.epoch"
const EpochStateTable = "epochstate"
const SysioOpregAccount = "sysio.opreg"
const OperatorsTable = "operators"
const SysioMsgchAccount = "sysio.msgch"
const EnvelopesTable = "envelopes"

// Cluster-path-relative surfaces.
const ClusterConfigFilename = "cluster-config.json"
const OppDebuggingSubdir = path.join("data", "opp-debugging")
const ClusterLogGlob = path.join("logs", "cluster_*.log")
const MetadataExtension = ".metadata"
const Localhost = "127.0.0.1"

// ---------------------------------------------------------------------------
// Watched flow process (cluster-scoped via its `-d <cluster-path>` argument)
// ---------------------------------------------------------------------------

/**
 * pgrep/pkill ERE matching the flow's process for THIS cluster only. The `[.]`
 * form matches the same literal command line as `lib/index.js` but keeps the
 * pattern from matching the monitor's own pgrep/pkill shell wrappers (their
 * command lines contain the pattern text verbatim, which `[.]` does not match).
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {string} the ERE handed to pgrep/pkill `-f`.
 */
function flowProcessPattern(clusterPath) {
  return `lib/index[.]js -d ${clusterPath}`
}

/**
 * Env var orchestrators (run-flows.mjs, the e2e gate) use to hand a flow its
 * cluster path — in that spawn mode the path never appears in argv.
 */
const ClusterPathEnvVar = "WIRE_CLUSTER_PATH"

/**
 * Broad candidate ERE for ANY flow executable (`node lib/index.js`), argv-less
 * of the cluster path. The `[.]` form keeps it from matching the monitor's own
 * pgrep shell wrappers (their command lines carry the pattern text verbatim,
 * which `[.]` does not match).
 */
const FlowExecutablePattern = "lib/index[.]js"

/**
 * PIDs of the watched flow's processes for THIS cluster, across BOTH spawn
 * modes: the direct-CLI form (`node lib/index.js -d <cluster-path>` — cluster
 * path in argv) and the orchestrator form (`pnpm --filter <pkg> test` with
 * `WIRE_CLUSTER_PATH=<cluster-path>` exported — cluster path ONLY in the
 * environment). The env form matches `lib/index.js` candidates by the exact
 * cluster path in `/proc/<pid>/environ`, so concurrent flows in a pooled run
 * stay isolated per monitor.
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<string[]>} matching pids (argv-form ∪ env-form).
 */
async function flowPids(clusterPath) {
  const normalized = clusterPath.replace(/\/+$/, "")
  const argvHits = await $`pgrep -f ${flowProcessPattern(normalized)}`.nothrow().quiet()
  const candidates = await $`pgrep -f ${FlowExecutablePattern}`.nothrow().quiet()
  const wantedEnvEntry = `${ClusterPathEnvVar}=${normalized}`
  const envHits = candidates.stdout
    .split("\n")
    .map(pid => pid.trim())
    .filter(Boolean)
    .filter(pid => {
      try {
        return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(wantedEnvEntry)
      } catch {
        return false // pid exited between the pgrep and the environ read
      }
    })
  const argvPids = argvHits.stdout.split("\n").map(pid => pid.trim()).filter(Boolean)
  return [...new Set([...argvPids, ...envHits])]
}

/**
 * Whether the watched flow process is still running (either spawn mode).
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<boolean>} true while a matching flow process exists.
 */
async function isFlowAlive(clusterPath) {
  return (await flowPids(clusterPath)).length > 0
}

/**
 * Whether the run has CONCLUDED on its own — the Report file is written at the
 * exact moment a flow finishes (success or failure), before its teardown stops
 * the cluster processes. During that ~30s teardown window a stopping producer
 * still answers probes with a frozen epoch and the flow process is alive in
 * cleanup, which is indistinguishable from a stall — this signal disambiguates
 * (2026-07-02: a SUCCEEDED reserve-lifecycle run was mis-bailed exactly there).
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {boolean} whether `<cluster>/reports/cluster-build.md` exists.
 */
function hasRunConcluded(clusterPath) {
  return fs.existsSync(path.join(clusterPath, "reports", "cluster-build.md"))
}

/**
 * Print the bail reason, SIGINT the watched flow (its exit handlers stop every
 * managed child; the cluster dir is preserved for forensics), and exit 1.
 *
 * Teardown guards: if the flow exited or its Report exists by the time the
 * bail decision lands, the run concluded on its own — report that and exit 0
 * instead of declaring a stall against a cluster that is simply shutting down.
 *
 * @param {string} reason human-readable bail reason (printed as `BAIL: <reason>`).
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<never>} never resolves — the process exits.
 */
async function bail(reason, clusterPath) {
  if (hasRunConcluded(clusterPath)) {
    console.log("RUN-CONCLUDED: Report present — teardown observed, not a stall (heartbeat ending)")
    process.exit(0)
  }
  if (!(await isFlowAlive(clusterPath))) {
    console.log("FLOW-EXITED at bail-time (heartbeat ending)")
    process.exit(0)
  }
  console.log(`BAIL: ${reason}`)
  // SIGINT every matched flow pid — covers both spawn modes (the argv-form
  // pkill alone misses env-spawned flows whose argv carries no cluster path).
  const pids = await flowPids(clusterPath)
  await Promise.all(pids.map(pid => $`kill -INT ${pid}`.nothrow().quiet()))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Cluster config — everything derivable derives from it, once it appears
// ---------------------------------------------------------------------------

/**
 * Read `<cluster-path>/cluster-config.json`: the resolved clio executable
 * (`executables.clio`) and the FIRST PRODUCER's HTTP URL
 * (`bind.nodeop.ports.producers[0].http`) — never bios, whose port stops
 * answering after the Phase 8 producer handoff.
 *
 * @param {string} clusterConfigPath absolute path to cluster-config.json.
 * @return {{ clioExecutable: string, producerUrl: string } | null} null while
 *   the config is absent or not yet fully written (the pre-config window).
 */
function readClusterConfig(clusterConfigPath) {
  if (!fs.existsSync(clusterConfigPath)) return null
  try {
    const config = fs.readJsonSync(clusterConfigPath)
    const clioExecutable = config?.executables?.clio
    const producerHttpPort = config?.bind?.nodeop?.ports?.producers?.[0]?.http
    if (clioExecutable == null || producerHttpPort == null) return null
    return { clioExecutable, producerUrl: `http://${Localhost}:${producerHttpPort}` }
  } catch {
    return null // mid-write JSON — same as absent; the next beat re-reads
  }
}

// ---------------------------------------------------------------------------
// Probes 1–4 — depot state via clio (v6 `-S` scope form, fields under `.value`)
// ---------------------------------------------------------------------------

/**
 * Run clio, returning stdout on success and null on ANY failure (non-zero
 * exit, timeout, spawn error) — a transient probe failure never kills the
 * monitor; it reads as `?` on the heartbeat line.
 *
 * @param {string} clioExecutable resolved clio binary (from cluster-config.json).
 * @param {string} url the producer HTTP URL.
 * @param {string[]} args clio arguments after `-u <url>`.
 * @return {Promise<string | null>} stdout, or null on failure.
 */
async function runClio(clioExecutable, url, args) {
  try {
    const result = await $`${clioExecutable} -u ${url} ${args}`.nothrow().quiet().timeout(ProbeTimeout)
    return result.exitCode === 0 ? result.stdout : null
  } catch {
    return null
  }
}

/**
 * JSON.parse that answers null instead of throwing.
 *
 * @param {string} text candidate JSON.
 * @return {unknown | null} the parsed value, or null on a parse failure.
 */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * `clio get table <code> <table> -S <scope> -l <limit>` → the rows array.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @param {string} code contract account owning the table.
 * @param {string} table table name.
 * @param {string} scope table scope (v6 `-S` form).
 * @param {number} limit row limit.
 * @return {Promise<object[] | null>} rows, or null when unreachable/unparseable.
 */
async function clioGetTableRows(clioExecutable, url, code, table, scope, limit) {
  const stdout = await runClio(clioExecutable, url, ["get", "table", code, table, "-S", scope, "-l", String(limit)])
  if (stdout == null) return null
  const rows = parseJson(stdout)?.rows
  return Array.isArray(rows) ? rows : null
}

/**
 * v6 KV rows arrive as `{key, value}` — the fields live under `.value`; fall
 * back to the row itself for non-KV shapes.
 *
 * @param {object} row a `get table` row.
 * @return {object} the field-carrying object.
 */
function kvRowValue(row) {
  return row?.value ?? row
}

/**
 * Probe 1 — chain liveness: `clio get info` → head_block_num.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<number | null>} the head block, or null while unreachable.
 */
async function probeChainLiveness(clioExecutable, url) {
  const stdout = await runClio(clioExecutable, url, ["get", "info"])
  if (stdout == null) return null
  const headBlockNumber = parseJson(stdout)?.head_block_num
  return typeof headBlockNumber === "number" ? headBlockNumber : null
}

/**
 * Probe 2 — operators summary (account / status / balance count). Queried on
 * every beat per the rule; intentionally NOT printed on the heartbeat line —
 * extend here when a flow needs an operator-status red flag (e.g. "operator
 * under test UNKNOWN with balance_count < required_chains").
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<Array<{ account: string, status: string, balanceCount: number }> | null>}
 *   one summary per operator, or null while unreachable.
 */
async function probeOperators(clioExecutable, url) {
  const rows = await clioGetTableRows(clioExecutable, url, SysioOpregAccount, OperatorsTable, SysioOpregAccount, TableQueryLimit)
  if (rows == null) return null
  return rows.map(kvRowValue).map(operator => ({
    account: operator?.account,
    status: operator?.status,
    balanceCount: operator?.balances?.length ?? 0
  }))
}

/**
 * Probe 3 — the `sysio.epoch::epochstate` singleton → current_epoch_index.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<number | null>} the epoch index, or null while the
 *   table/row doesn't exist yet (pre-bootstrap) or the probe fails.
 */
async function probeEpochState(clioExecutable, url) {
  const rows = await clioGetTableRows(clioExecutable, url, SysioEpochAccount, EpochStateTable, SysioEpochAccount, 1)
  const rawIndex = kvRowValue(rows?.[0])?.current_epoch_index
  if (rawIndex == null) return null
  const epochIndex = Number(rawIndex)
  return Number.isFinite(epochIndex) ? epochIndex : null
}

/**
 * Probe 4 — `sysio.msgch::envelopes` row count (caps at TableQueryLimit).
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<number | null>} the row count, or null while unreachable.
 */
async function probeEnvelopes(clioExecutable, url) {
  const rows = await clioGetTableRows(clioExecutable, url, SysioMsgchAccount, EnvelopesTable, SysioMsgchAccount, TableQueryLimit)
  if (rows == null) return null
  return rows.length
}

// ---------------------------------------------------------------------------
// Probe 5 — opp-debugging artifacts (total + per-direction .metadata counts)
// ---------------------------------------------------------------------------

/**
 * Count `.metadata` artifacts under `<cluster-path>/data/opp-debugging/`,
 * total + per direction (file names are `<epoch>-<DIRECTION>-<checksum>.metadata`).
 *
 * @param {string} oppDebuggingDir the opp-debugging directory.
 * @return {Promise<{ total: number, byDirection: Record<string, number> }>}
 *   zero counts while the directory doesn't exist yet.
 */
async function probeOppArtifacts(oppDebuggingDir) {
  let names = []
  try {
    names = fs.existsSync(oppDebuggingDir) ? await fs.readdir(oppDebuggingDir) : []
  } catch {
    names = [] // racing the directory's creation — same as empty
  }
  const metadataNames = names.filter(name => name.endsWith(MetadataExtension))
  const byDirection = Object.fromEntries(
    OppDirections.map(direction => [
      direction.name,
      metadataNames.filter(name => name.includes(`-${direction.name}-`)).length
    ])
  )
  return { total: metadataNames.length, byDirection }
}

// ---------------------------------------------------------------------------
// Probe 6 — aggregate cluster log (action receipts + FATAL/NOISE classes)
// ---------------------------------------------------------------------------

/**
 * The first (lexicographically — there is normally exactly one)
 * `logs/cluster_*.log` under the cluster path.
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<string | undefined>} the log path, or undefined while absent.
 */
async function resolveClusterLogFile(clusterPath) {
  const files = await glob(path.join(clusterPath, ClusterLogGlob))
  return files.sort()[0]
}

/**
 * The probe-6 result while no aggregate log exists yet.
 *
 * @return {{ actionReceipts: string[], fatalCount: number, fatalTail: string[], noiseCount: number, noiseTail: string }}
 *   an all-zero probe result.
 */
function emptyLogProbe() {
  return { actionReceipts: [], fatalCount: 0, fatalTail: [], noiseCount: 0, noiseTail: "" }
}

/**
 * Grep the aggregate log for the probe-6 surface: top-N action receipts,
 * FATAL lines (count + tail), NOISE count + last quoted message. Runs through
 * grep pipelines (never an in-memory read) so large logs stay cheap; NOISE is
 * counted without buffering its lines — it reaches tens of thousands on
 * 9-operator clusters, which is exactly WHY it is classed as noise.
 *
 * @param {string} clusterLogFile the aggregate cluster log path.
 * @return {Promise<{ actionReceipts: string[], fatalCount: number, fatalTail: string[], noiseCount: number, noiseTail: string }>}
 *   the parsed probe result.
 */
async function probeAggregateLog(clusterLogFile) {
  const receiptsResult =
    await $`grep -oE ${ActionReceiptPattern} ${clusterLogFile} | sort | uniq -c | sort -rn | head -n ${String(TopActionReceipts)}`
      .nothrow()
      .quiet()
  const actionReceipts = receiptsResult.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [count, action] = line.split(/\s+/)
      return `${action}:${count}`
    })

  const fatalResult = await $`grep -E ${FatalSignaturePattern} ${clusterLogFile} | grep -vE ${FatalExcludePattern}`
    .nothrow()
    .quiet()
  const fatalLines = fatalResult.stdout.split("\n").filter(line => line.length > 0)

  const noiseCountResult =
    await $`grep -E ${NoiseSignaturePattern} ${clusterLogFile} | grep -cvE ${EchoWrapperExcludePattern}`
      .nothrow()
      .quiet()
  const noiseCount = Number(noiseCountResult.stdout.trim()) || 0

  const noiseTailResult =
    await $`grep -E ${NoiseTailSourcePattern} ${clusterLogFile} | grep -vE ${TrxEchoExcludePattern} | tail -n 1`
      .nothrow()
      .quiet()
  const noiseTailMatch = noiseTailResult.stdout.match(new RegExp(`${NoiseTailSourcePattern}: .*`))
  const noiseTail = (noiseTailMatch?.[0] ?? "").slice(0, NoiseTailMaxLength)

  return {
    actionReceipts,
    fatalCount: fatalLines.length,
    fatalTail: fatalLines.slice(-FatalTailLines),
    noiseCount,
    noiseTail
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Print the usage text (also shown on `--help`). */
function printUsage() {
  echo(`
${chalk.bold("Flow-run heartbeat monitor")} — the standing implementation of
wire-platform-manifest/.claude/rules/cluster-state-active-probing.md
(all 6 probes + every bail, incl. the FATAL/NOISE failure classes).

${chalk.bold("Usage:")}
  ./scripts/flow-heartbeat-monitor.mjs [cluster-path] [options]

${chalk.bold("Options:")}
  --cluster-path <path>          cluster data dir of the flow run under watch
                                 (or pass it as the first positional arg). Required.
  --interval-seconds <n>         seconds between heartbeats (default: ${DefaultIntervalSeconds})
  --epoch-duration-seconds <n>   the cluster's epoch duration (default: ${DefaultEpochDurationSeconds});
                                 scales the bootstrap-deadline bail and labels
                                 the epoch-stall bail
  -h, --help                     print this usage

${chalk.bold("Output")} (line-oriented on stdout; each line is a Monitor event):
  HB t=<s> head=<n> epoch=<n> env=<n> opp=<total> Δ=<delta> dirs: D>E=<n> E>D=<n> D>S=<n> S>D=<n> acts=[...] fatal=<n>(+<d>) noise=<n>(+<d>)
  NOISE-TAIL: / FAIL-TAIL:  quote lines when the class deltas are positive
  BAIL: <reason>            a red flag fired → SIGINTs the flow, exits 1
                            (cluster dir preserved for forensics)
  FLOW-EXITED ...           the watched flow process ended → exits 0

${chalk.bold("Example")} — pairing with a flow run (same cluster path on both sides):
  # 1. start the flow (terminal 1, or a background task)
  ./scripts/run-flow.mjs swap-with-underwriting --cluster-path /tmp/wire-flow-1 ...
  # 2. arm the monitor against the SAME --cluster-path (terminal 2 / a Monitor)
  node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-1
`)
}

/**
 * Resolve the required cluster path from `--cluster-path` or the first
 * positional argument (run-flow.mjs convention). Exits 1 when absent.
 *
 * @return {string} the resolved absolute cluster path.
 */
function resolveClusterPath() {
  const value = argv["cluster-path"] ?? (argv._[0] != null ? String(argv._[0]) : null)
  if (value == null || String(value).length === 0) {
    echo(chalk.red("Error: --cluster-path is required (flag or first positional arg)."))
    printUsage()
    process.exit(1)
  }
  return path.resolve(String(value))
}

/**
 * Resolve a positive-number option, falling back to its default. Exits 1 on a
 * non-numeric / non-positive value.
 *
 * @param {string} flagName the option name (without leading dashes).
 * @param {number} defaultValue value when the flag is omitted.
 * @return {number} the resolved value.
 */
function resolveNumberOption(flagName, defaultValue) {
  const raw = argv[flagName]
  if (raw == null) return defaultValue
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    echo(chalk.red(`Error: --${flagName} must be a positive number (got: ${raw}).`))
    process.exit(1)
  }
  return value
}

if (argv.help === true || argv.h === true) {
  printUsage()
  process.exit(0)
}

const clusterPath = resolveClusterPath()
const intervalSeconds = resolveNumberOption("interval-seconds", DefaultIntervalSeconds)
const epochDurationSeconds = resolveNumberOption("epoch-duration-seconds", DefaultEpochDurationSeconds)

const clusterConfigPath = path.join(clusterPath, ClusterConfigFilename)
const oppDebuggingDir = path.join(clusterPath, OppDebuggingSubdir)

/** Bootstrap deadline: epoch must reach >= 1 within this many seconds of first chain liveness. */
const bootstrapDeadlineSeconds = Math.max(BootstrapDeadlineFloorSeconds, epochDurationSeconds * 3)

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

let previousEpochIndex = -1
let previousOppTotal = 0
let previousFatalCount = 0
let previousNoiseCount = 0
let fatalGrowthStreak = 0
let firstLivenessTimestamp = null
const previousDirectionCounts = Object.fromEntries(OppDirections.map(direction => [direction.name, 0]))
const directionFreezeStreaks = Object.fromEntries(OppDirections.map(direction => [direction.name, 0]))
const startTimestamp = Date.now()

while (true) {
  await sleep(intervalSeconds * 1000)
  const now = Date.now()
  const elapsedSeconds = Math.round((now - startTimestamp) / 1000)

  if (!(await isFlowAlive(clusterPath))) {
    console.log(`FLOW-EXITED at t=${elapsedSeconds}s (heartbeat ending)`)
    process.exit(0)
  }

  const clusterConfig = readClusterConfig(clusterConfigPath)
  if (clusterConfig == null) {
    console.log(`HB t=${elapsedSeconds}s (pre-config)`)
    continue
  }
  const { clioExecutable, producerUrl } = clusterConfig

  // Probe 1 — chain liveness (also starts the bootstrap-deadline clock).
  const headBlockNumber = await probeChainLiveness(clioExecutable, producerUrl)
  if (headBlockNumber != null && firstLivenessTimestamp == null) {
    firstLivenessTimestamp = now
  }

  // Probe 2 — operators (queried every beat; see probeOperators for why unprinted).
  await probeOperators(clioExecutable, producerUrl)

  // Probe 3 — epoch state.
  let epochIndex = await probeEpochState(clioExecutable, producerUrl)

  // Probe 4 — msgch outbound envelopes.
  const envelopeCount = await probeEnvelopes(clioExecutable, producerUrl)

  // Probe 5 — opp-debugging artifacts + per-direction freeze accounting.
  // A plateau = a direction FROZEN for DirectionFreezeBailStreak consecutive
  // beats while the total advances — evaluated only once EVERY direction has a
  // non-zero baseline. A single same-count beat right after the baselines
  // appear is normal ramp, not a plateau.
  const opp = await probeOppArtifacts(oppDebuggingDir)
  const oppDelta = opp.total - previousOppTotal
  const allDirectionsHaveBaseline = OppDirections.every(direction => opp.byDirection[direction.name] > 0)
  let plateauDirection = null
  OppDirections.forEach(direction => {
    const count = opp.byDirection[direction.name]
    const frozenWhileOthersAdvance =
      allDirectionsHaveBaseline && count === previousDirectionCounts[direction.name] && oppDelta > 0
    directionFreezeStreaks[direction.name] = frozenWhileOthersAdvance
      ? directionFreezeStreaks[direction.name] + 1
      : 0
    if (directionFreezeStreaks[direction.name] >= DirectionFreezeBailStreak) {
      plateauDirection = direction.name
    }
    previousDirectionCounts[direction.name] = count
  })

  // Probe 6 — aggregate cluster log.
  const clusterLogFile = await resolveClusterLogFile(clusterPath)
  const logProbe = clusterLogFile != null ? await probeAggregateLog(clusterLogFile) : emptyLogProbe()

  const fatalDelta = logProbe.fatalCount - previousFatalCount
  const noiseDelta = logProbe.noiseCount - previousNoiseCount
  previousNoiseCount = logProbe.noiseCount
  fatalGrowthStreak = fatalDelta > 0 ? fatalGrowthStreak + 1 : 0

  const directionsText = OppDirections.map(
    direction => `${direction.short}=${opp.byDirection[direction.name]}`
  ).join(" ")
  console.log(
    `HB t=${elapsedSeconds}s head=${headBlockNumber ?? "?"} epoch=${epochIndex ?? "?"} ` +
      `env=${envelopeCount ?? "?"} opp=${opp.total} Δ=${oppDelta} dirs: ${directionsText} ` +
      `acts=[${logProbe.actionReceipts.join(" ")}] ` +
      `fatal=${logProbe.fatalCount}(+${fatalDelta}) noise=${logProbe.noiseCount}(+${noiseDelta})`
  )
  if (noiseDelta > 0 && logProbe.noiseTail.length > 0) {
    console.log(`NOISE-TAIL: ${logProbe.noiseTail}`)
  }
  if (fatalDelta > 0 && epochIndex != null && epochIndex !== 0) {
    console.log(`FAIL-TAIL: ${logProbe.fatalTail.join(" | ")}`)
  }

  // ── bails ──
  // Bootstrap fallback: chain answering but epoch still null/0 past the
  // deadline. Every other bail is gated on epoch >= 1 — without this fallback
  // a monitor against a dead-during-bootstrap chain would print forever.
  if (firstLivenessTimestamp != null && (epochIndex == null || epochIndex === 0)) {
    const livenessSeconds = Math.round((now - firstLivenessTimestamp) / 1000)
    if (livenessSeconds > bootstrapDeadlineSeconds) {
      await bail(
        `bootstrap never completed: current_epoch_index=${epochIndex ?? "null"} after ${livenessSeconds}s of chain liveness`,
        clusterPath
      )
    }
  }
  if (epochIndex != null && epochIndex >= 1) {
    // Epoch stall: a same-epoch heartbeat at 60s epochs is the fatal signal,
    // but consensus latency makes the effective cadence ~90–105s — re-probe
    // once after EpochStallReprobeDelaySeconds and bail only if STILL
    // unchanged (a true stall = dead cluster).
    if (epochIndex === previousEpochIndex) {
      await sleep(EpochStallReprobeDelaySeconds * 1000)
      const reprobedEpochIndex = await probeEpochState(clioExecutable, producerUrl)
      if ((reprobedEpochIndex ?? epochIndex) === previousEpochIndex) {
        await bail(
          `epoch stalled at ${epochIndex} across heartbeat + ${EpochStallReprobeDelaySeconds}s re-probe (epoch_duration=${epochDurationSeconds}s)`,
          clusterPath
        )
      }
      epochIndex = reprobedEpochIndex
    }
    // Zero opp-debugging delta once epoch >= 1: fatal on the FIRST occurrence.
    if (oppDelta <= 0 && previousOppTotal > 0) {
      await bail(`opp-debugging zero growth (total=${opp.total}) on a post-bootstrap heartbeat`, clusterPath)
    }
    if (oppDelta <= 0 && previousOppTotal === 0 && previousEpochIndex >= 1) {
      await bail(`opp-debugging EMPTY (no artifacts at all) with epoch=${epochIndex}`, clusterPath)
    }
    // FATAL growth: bail on PERSISTENT growth only — one-off transients (nonce
    // retries, momentary table-read races) occur in PASSING runs; persistent
    // plugin breakage grows every cycle.
    if (fatalGrowthStreak >= FatalGrowthBailStreak) {
      await bail(
        `failure signatures growing across consecutive heartbeats (count=${logProbe.fatalCount}): ${logProbe.fatalTail[0] ?? ""}`,
        clusterPath
      )
    }
    if (plateauDirection != null) {
      await bail(
        `direction ${plateauDirection} frozen for ${DirectionFreezeBailStreak}+ heartbeats while total advanced`,
        clusterPath
      )
    }
  }

  previousEpochIndex = epochIndex ?? previousEpochIndex
  previousOppTotal = opp.total
  previousFatalCount = logProbe.fatalCount
}
