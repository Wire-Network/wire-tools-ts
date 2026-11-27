#!/usr/bin/env node
/**
 * Flow-run heartbeat monitor — the standing, executable implementation of the
 * cluster-state active-probing rule
 * (`wire-platform-manifest/.claude/rules/cluster-state-active-probing.md`).
 *
 * Watches ONE running flow (a `wire-cluster-tool` / flow run driving a cluster
 * at `--cluster-path`) and, every `--interval-seconds`, executes ALL six probes
 * from the rule, printing ONE line-oriented, flushed heartbeat on stdout:
 *
 *   HB t=<s> head=<n> lib=<n>(-<gap>) epoch=<CHAIN>:<n>[p][i|w|d|?][u],... qreports=<CHAIN>:<r>/<s>[+<r>/<s>],... env=<n> opp=<total> Δ=<delta> dirs: D>E=<n> E>D=<n> D>S=<n> S>D=<n> acts=[...] fatal=<n>(+<d>) noise=<n>(+<d>)
 *
 * (`epoch=` lists every outpost chain's own consensus epoch: a `p` suffix marks a paused
 * chain, then `i` an idle chain (no traffic, so it legitimately stays in its epoch), `w` a
 * chain with traffic waiting for its `due_at`, `d` a chain that is due and should advance, `?` a
 * chain whose `due_at` does not read — unknown, never treated as idle; then `u` while its
 * current epoch is still undecided. `qreports=` lists each chain's backlog reports in its
 * current epoch (`sysio.msgch::qreports`): the reporters `r` over the seats `s` of its group on
 * duty, then `+r/s` for the next group of its window, which reports too, counting only members
 * that are ACTIVE and not EVICTED from the chain; reports from a strict majority of one group's
 * seats record the chain's traffic, the two groups' never adding up; `?` while unknown)
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
 *   3. epoch state per chain     — `sysio.epoch::epochstate`, one row per outpost chain → index, start, traffic_since, due_at + pause,
 *                                  `sysio.epoch::epochcfg` → each chain's epoch duration (the depot's value),
 *                                  `sysio.msgch::outpcons` → the epoch each chain decided last,
 *                                  and `sysio.msgch::qreports` + `sysio.opreg::servchains` → each chain's
 *                                  current-epoch backlog reports over its reporting groups' seats
 *   4. msgch outbound envelopes  — `sysio.msgch::envelopes` row count
 *   5. opp-debugging artifacts   — total + per-direction `.metadata` counts + delta
 *   6. aggregate cluster log     — action-receipt top-3 + the TWO failure classes:
 *      FATAL (plugin/execution signatures that stop OPP circulation — bail on
 *      persistent growth) and NOISE (chain `assertion failure` gate rejections —
 *      counted + quoted, NEVER a bail).
 *
 * Epochs are depot-paced: a chain advances only once it is due — it has traffic
 * (`traffic_since`) and its `due_at` (the later of its epoch start plus its
 * minimum duration and that traffic plus its traffic wait) has passed — so an
 * IDLE chain (no traffic, `due_at` zero) legitimately stays in its epoch for as
 * long as it is idle, and an idle cluster legitimately grows no OPP artifacts.
 * Idle is never a stall: the epoch-stall, zero-growth and plateau bails fire only
 * on a chain that is DUE and overdue, measured on the depot's own clock (`head_block_time`). That clock stops
 * when the producers stop, so two bails do not lean on it alone: the head-advance
 * bail measures block production on the monitor's wall clock, and the
 * undecided-epoch bail catches a chain whose current epoch never gets decided,
 * traffic or not.
 *
 * The bails (print `BAIL: <reason>`, SIGINT the watched flow, exit 1):
 *   - head frozen — the depot head block number unchanged across a beat, and
 *     still unchanged after a re-probe (wall clock): producers stopped while
 *     HTTP still answers. Fires with or without `--expect-epoch-freeze` (a
 *     dispute pause freezes epochs, never blocks)
 *   - epoch undecided too long — a started, unpaused chain whose current epoch
 *     (the genesis epoch included) is still undecided (`outpcons`) more than
 *     `max(UndecidedEpochFloorSeconds, UndecidedEpochDurations × its minimum)`
 *     after the later of its `current_epoch_start` and the first beat that saw
 *     it in that epoch (on the head clock); suppressed by `--expect-epoch-freeze`
 *   - bootstrap never completes — a chain's epoch still null/0 past the deadline since first
 *     liveness (the deadline scales with that chain's duration); the genesis advance
 *     needs no traffic
 *   - epoch stall — a chain at the same epoch as the previous beat whose `due_at` is set
 *     and lies about 2 x its own minimum duration behind the head, AND still at that
 *     epoch after a re-probe
 *   - opp-debugging zero delta on a beat at/past the first epoch boundary of
 *     every chain (the latest of each chain's first epoch start + its duration,
 *     controller ruling for self-check 6) while some chain has been due for at
 *     least a whole beat. Before that wall-clock boundary, zero delta is marked
 *     growth=first-epoch-boundary in HB and does not bail. The boundary never
 *     resets on epoch advance. It comes from each chain's
 *     epochstate.current_epoch_start and its duration (or
 *     --epoch-duration-seconds).
 *   - one direction frozen for 2 consecutive beats while the total advances —
 *     a direction counts only while its chain is due, and only after all four
 *     directions have a non-zero baseline
 *   - FATAL count growing across 2 consecutive beats
 *
 * A chain's epoch duration is its minimum, `sysio.epoch::epochcfg.epoch_duration_sec`,
 * read every beat; before the chain's row exists it is the cluster-config
 * `outpostEpochDurationSec` its bootstrap will write there, and before that names
 * the chain the cluster's `epochDurationSec` (60 s when that is `null`).
 * `--epoch-duration-seconds` overrides every chain's.
 *
 * Exits 0 with a `FLOW-EXITED` line when the watched flow process disappears.
 *
 * Usage:
 *   node scripts/flow-heartbeat-monitor.mjs --cluster-path <cluster> [options]
 *   (run `--help` for the full option list and a pairing example)
 * Options:
 *   --expect-freeze   only for flow-emergency-stop: classify exact OutpostFrozen
 *                     (0x17c7), EnforcedPause and NoPendingDesyndication
 *                     recovery refusals as NOISE. Default: FATAL.
 *                     Does not disable any liveness bail.
 *   --expect-epoch-freeze  the flow deliberately holds a chain that is due (a
 *                     pause, an undeliverable group): suppresses the epoch-stall,
 *                     undecided-epoch, zero-growth and direction-plateau bails. An
 *                     idle chain needs no flag. The head-advance bail stays on.
 */

import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { argv, chalk, echo, fs, glob, path, $, sleep } from "zx"
import { SysioContracts } from "@wireio/sdk-core"

import {
  chainCodename,
  chainEpochConfigs,
  chainEpochDurations,
  chainEpochStates,
  chainOutpostConsensus,
  EpochStateRowLimit,
  isCurrentEpochDecided,
  kvRowValue,
  timePointMs
} from "./common/epoch-state.mjs"

// ---------------------------------------------------------------------------
// Constants — tuning knobs + probe surface
// ---------------------------------------------------------------------------

/**
 * Seconds between heartbeats. Raising it slows detection of every bail;
 * it is also the time a chain must have been due before a zero-delta beat
 * bails (a due chain ships an envelope within its delivery extension).
 * Overridable via `--interval-seconds`.
 */
const DefaultIntervalSeconds = 90

/**
 * An outpost chain's minimum epoch duration when neither its `epochcfg` row nor
 * the cluster config names one. Each chain's duration scales its
 * bootstrap-deadline bail (`max(BootstrapDeadlineFloorSeconds,
 * BootstrapDeadlineEpochs × duration)`) and its epoch-stall grace past `due_at`.
 * `--epoch-duration-seconds` overrides every chain's.
 */
const DefaultEpochDurationSeconds = 60

/**
 * Epoch durations of a chain the bootstrap-never-completed deadline allows at
 * least (`max(BootstrapDeadlineFloorSeconds, this × duration, …)`). Raising it
 * tolerates a slower first advance; lowering it risks bailing on a healthy
 * long-epoch chain.
 */
const BootstrapDeadlineEpochs = 3

/**
 * The chain the bootstrap-never-completed bail names when the monitor knows of
 * no outpost chain at all — no epochstate or epochcfg row yet and no chain in
 * the cluster config. A bail label only: it never keys a per-chain record.
 */
const NoEpochStateLabel = "(no epochstate row)"

/**
 * A DUE chain's epoch is stalled once its `due_at` lies this many of its own
 * minimum durations behind the depot head with no advance
 * (`epoch-stall-is-fatal.md`: about 2 ×). An idle chain is never stalled.
 * Raising it delays the stall bail; lowering it below the delivery extension
 * (~30 s past due) false-bails a healthy chain.
 */
const EpochStallDurations = 2

/**
 * Floor (seconds of chain liveness with epoch still null/0) for the
 * bootstrap-never-completed bail. Raising it tolerates slower deploy phases;
 * lowering it risks bailing on a healthy-but-slow bootstrap.
 */
const BootstrapDeadlineFloorSeconds = 300

/**
 * Per-provisioned-identity allowance (seconds) folded into the bootstrap
 * deadline. Bootstrap latency is a property of the TOPOLOGY, not a constant:
 * the window between "the chain answers" and "epoch >= 1" is dominated by
 * per-identity on-chain writes (account creation, key publication, operator
 * registration, authex links), each of which waits for irreversibility — and
 * LIB lag itself grows with the producer count (the same force behind
 * `ProtocolTiming.irreversibleWaitBudgetMs`).
 *
 * At the 1-producer/3-batch-op/1-underwriter dev default this yields
 * 5 x 60 = 300s — exactly the floor, so every existing flow's bail behavior is
 * UNCHANGED; only large topologies get the longer leash they actually need.
 * Raising it tolerates larger clusters; lowering it risks SIGINT-ing a
 * healthy-but-large bootstrap.
 */
const BootstrapPerIdentitySeconds = 60

/**
 * Delay before the epoch-stall re-probe. A due chain still at its previous
 * epoch is re-probed once its overdue time plus this delay reaches its stall
 * grace, and bails only if STILL at that epoch after it (a due chain that
 * cannot advance = dead cluster). Raising it delays the stall bail; lowering
 * it re-introduces delivery-jitter false positives.
 */
const EpochStallReprobeDelaySeconds = 45

/**
 * Delay (wall clock) before the head-advance re-probe. A head block number
 * unchanged across a whole beat is re-read once after this delay, and the
 * monitor bails only if it is STILL unchanged: the depot produces a block every
 * half second, so a head that stands still that long means the producers have
 * stopped, whatever the HTTP endpoint still answers. Raising it delays the bail;
 * lowering it risks bailing on one slow `get info` round trip.
 */
const HeadStallReprobeDelaySeconds = 15

/**
 * Minimum durations of a chain after which its current epoch, still undecided,
 * is a stall (`max(UndecidedEpochFloorSeconds, this × minimum)`, counted from the
 * later of the epoch's start and the first beat that saw it). The value is the
 * time a live chain needs to decide an epoch, from the harness's timing
 * constants: the bootstrap gate allows the epoch's round trip
 * `ProtocolTiming.EpochVerifyEpochCount` (3) effective epochs of
 * `minimum + ProtocolTiming.EpochExtensionMaxSec` (30 s), never under
 * `ProtocolTiming.OppCirculationRestartMs` (240 s): `max(3 × (minimum + 30), 240)` s,
 * which 5 × minimum covers from a 50 s minimum up; {@link UndecidedEpochFloorSeconds}
 * covers the shorter minimums. A split held open by a silent member never
 * disputes, so this bail is its alarm; a dispute pauses the chain, which this
 * bail skips. A normal round trip decides an epoch within seconds, far inside it.
 * Lowering it below 4 false-bails a slow round trip of a chain with a minimum
 * over 110 s.
 */
const UndecidedEpochDurations = 5

/**
 * Floor (seconds) of the undecided-epoch bail: `ProtocolTiming.SingleHopBudgetMs`,
 * the 7 minutes one OPP hop is budgeted. It covers every chain whose minimum is
 * too short for {@link UndecidedEpochDurations} alone: for a minimum up to 110 s
 * the decision time `max(3 × (minimum + 30), 240)` s is at most 420 s. Lowering
 * it below that false-bails a short-epoch chain restarting OPP circulation.
 */
const UndecidedEpochFloorSeconds = 420

/**
 * Consecutive frozen beats (a direction's count unchanged while the total
 * advances AND the direction's chain is due) before the direction-plateau bail.
 * Evaluated only once EVERY direction has a non-zero baseline; an idle chain's
 * directions never count. Lowering to 1 flags the normal post-baseline ramp as
 * a plateau.
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

/** Row limit for the envelopes probe — the envelope count caps here. */
const TableQueryLimit = 50

/**
 * The four OPP directions in heartbeat-line order, with their short labels and
 * the outpost chain each runs on (the chain whose traffic paces it).
 */
export const OppDirections = [
  { name: "DEPOT_OUTPOST_ETHEREUM", short: "D>E", chain: "ETHEREUM" },
  { name: "OUTPOST_ETHEREUM_DEPOT", short: "E>D", chain: "ETHEREUM" },
  { name: "DEPOT_OUTPOST_SOLANA", short: "D>S", chain: "SOLANA" },
  { name: "OUTPOST_SOLANA_DEPOT", short: "S>D", chain: "SOLANA" }
]

/**
 * A started chain's traffic, as the heartbeat marks it and the bails gate on:
 * `idle` (no traffic: it stays in its epoch, never a stall), `waiting` (traffic,
 * its `due_at` still ahead of the head), `due` (it should advance) and `unknown`
 * (its `due_at` is absent or does not parse: never read as idle, never as due).
 * Identity values; frozen so a probe can never redefine one.
 */
export const ChainTraffic = Object.freeze({ idle: "idle", waiting: "waiting", due: "due", unknown: "unknown" })

/** The heartbeat's `epoch=` suffix of each {@link ChainTraffic} value. */
const ChainTrafficMarks = Object.freeze({
  [ChainTraffic.idle]: "i",
  [ChainTraffic.waiting]: "w",
  [ChainTraffic.due]: "d",
  [ChainTraffic.unknown]: "?"
})

/** The heartbeat's `epoch=` suffix of a started chain whose current epoch is still undecided. */
const UndecidedMark = "u"

// Failure classing (probe 6) — TWO classes, per the probing rule:
//   FATAL — plugin-layer / execution failures that stop OPP circulation; the
//   monitor bails on their PERSISTENT growth.
//   NOISE — chain `assertion failure` rejections: the depot's own gates
//   bouncing retrying/unscheduled crankers (duplicate deliver, stale nonce,
//   not-in-active-group, ...). Counted + quoted, NEVER a bail — the liveness
//   probes (a due chain's epoch advance, opp delta while a chain is due,
//   per-direction growth of due chains) are the gates.

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
 * Expected NEGATIVE-TEST reverts — a flow deliberately submits an invalid action
 * to VERIFY the outpost/contract rejects it, so the revert IS the asserted
 * success path, not a failure. flow-yield-distribution submits a non-monotonic
 * `externalEpochRef` to prove `MockYieldEmitter` enforces monotonicity. NOISE
 * (an expected, self-contained rejection), never FATAL — the revert otherwise
 * matches the generic `execution reverted` FATAL signature and false-bails a
 * healthy flow on its growth. Emergency-stop refusals are NOT covered here:
 * those are FATAL unless the monitor explicitly receives --expect-freeze.
 */
const NegativeTestRevertPattern =
  "MockYieldEmitter: externalEpochRef not monotonic"

/** Exact freeze/recovery reasons, including raw Ethereum selectors. Longer
 * hex codes and containing identifiers do not match. These are only noise
 * under --expect-freeze; independent failures on the same line remain fatal. */
const FreezeRefusalSource = String.raw`custom program error: 0x17c7(?![0-9a-fA-F])|\b(?:EnforcedPause|WIRE_NoPendingDesyndication)\b(?:\(\))?|custom error 0x(?:d93c0665|287022ed)(?![0-9a-fA-F])`
const FreezeRefusalPattern = new RegExp(FreezeRefusalSource)

/**
 * Strip ONLY an expected refusal and directly attached failure wrappers, not
 * its entire line. Any independent failure left on the line stays FATAL.
 * Unknown wrapper shapes remain conservative: they still count as failures.
 */
const FreezeFailurePattern = new RegExp(
  String.raw`(?:(?:execution reverted|Program [\w.:/-]+ failed|simulation failed|Error processing Instruction [0-9]+|InstructionError|batch_operator|underwriter|outpost_(?:ethereum|solana)_client):\s*)*(?:${FreezeRefusalSource})`,
  "g"
)

/**
 * FATAL exclusions: the echo wrappers PLUS `sysio_assert_message` — a
 * plugin-tagged line whose payload is a chain assertion is the plugin
 * NARRATING chain noise (its push bounced off a depot gate): NOISE, not a
 * plugin failure. Removing this exclusion re-creates the false-positive bails
 * on healthy 9-operator clusters. Registry-sync lag bounces are excluded for
 * the same reason (see {@link RegistrySyncLagPattern}).
 */
const FatalExcludePattern = `${EchoWrapperExcludePattern}|sysio_assert_message|${RegistrySyncLagPattern}|${NegativeTestRevertPattern}`

/** NOISE signatures (ERE): chain assertion-failure gate rejections + outpost
 *  registry-sync lag bounces + expected negative-test reverts (counted +
 *  quoted, never a bail). */
const NoiseSignaturePattern = `assertion failure|${RegistrySyncLagPattern}|${NegativeTestRevertPattern}`

/** The line shapes the NOISE tail quotes (they carry the actual reason). */
const NoiseTailSourcePattern = `assertion failure with message|${RegistrySyncLagPattern}|${NegativeTestRevertPattern}`

/** Action-receipt shape in the aggregate log (`sysio.<contract>::<action>`). */
const ActionReceiptPattern = "sysio\\.[a-z]+::[a-z]+"

// Depot accounts / tables probed each beat (v6 form: `clio get table <code> <table> -S <scope>`).
const SysioEpochAccount = "sysio.epoch"
const EpochStateTable = "epochstate"
const EpochConfigTable = "epochcfg"
const SysioOpregAccount = "sysio.opreg"
const OperatorsTable = "operators"
const SysioMsgchAccount = "sysio.msgch"
const EnvelopesTable = "envelopes"
const OutpostConsensusTable = "outpcons"
const QueueReportsTable = "qreports"
const ServedChainsTable = "servchains"

/**
 * Row limit of the operator (`sysio.opreg::operators`), backlog-report (`sysio.msgch::qreports`,
 * one row per outpost chain and reporting batch operator) and membership
 * (`sysio.opreg::servchains`, one row per batch operator and chain it joined) probes. A read
 * truncated at it counts as unread, so a chain's reporters read as unknown rather than short.
 */
const MembershipRowLimit = 200

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
 * Broad candidate ERE for the cluster CLI's cluster-scoped commands
 * (`wire-cluster-tool … create|run` — the bootstrap-a-new-cluster and
 * resume-a-created-cluster entry points; the former runs the whole build, the
 * latter parks while its daemons serve). Candidates are narrowed to THIS
 * cluster by exact argv TOKENS read from /proc/<pid>/cmdline — never by
 * substring — so sibling clusters (`…-001` vs `…-0012`) and the monitor's
 * own pgrep/shell wrappers (whose command lines carry the text only inside
 * one composite argument) never match.
 */
const ClusterCliExecutablePattern = "wire-cluster-tool"

/**
 * The cluster CLI commands this monitor watches. `create` is included because a
 * bootstrap IS the long-running work most worth watching — the create-cluster
 * workflow runs it unattended for hours — and its epoch-0 window is exactly
 * what the topology-scaled bootstrap deadline exists to bound.
 * `destroy`/`package`/`create-external-config` are short and unwatched.
 */
const ClusterCliCommandNames = ["create", "run"]

/** Argv flag spellings that carry the cluster path for the cluster CLI. */
const ClusterPathFlagNames = ["-d", "--cluster-path"]

/**
 * Whether a NUL-split /proc cmdline is a watched `wire-cluster-tool` command
 * for the given cluster: it carries one of {@link ClusterCliCommandNames} as a
 * discrete token AND the cluster path as `-d <path>`, `--cluster-path <path>`,
 * or `--cluster-path=<path>`.
 *
 * @param {string[]} args NUL-split argv tokens.
 * @param {string} clusterPath the normalized cluster path.
 * @return {boolean} whether this argv addresses a watched command for the cluster.
 */
function isClusterCliArgv(args, clusterPath) {
  if (!ClusterCliCommandNames.some(command => args.includes(command))) return false
  return args.some((arg, index) =>
    ClusterPathFlagNames.some(
      flag => arg === `${flag}=${clusterPath}` || (arg === flag && args[index + 1] === clusterPath)
    )
  )
}

/**
 * PIDs of the `wire-cluster-tool create`/`run` process for THIS cluster — the
 * liveness anchor for CLI-driven clusters, exactly as the flow process is for
 * flows.
 *
 * @param {string} clusterPath the normalized cluster path.
 * @return {Promise<string[]>} matching pids.
 */
async function clusterCliPids(clusterPath) {
  const candidates = await $`pgrep -f ${ClusterCliExecutablePattern}`.nothrow().quiet()
  return candidates.stdout
    .split("\n")
    .map(pid => pid.trim())
    .filter(Boolean)
    .filter(pid => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        return isClusterCliArgv(args, clusterPath)
      } catch {
        return false // pid exited between the pgrep and the cmdline read
      }
    })
}

/**
 * PIDs of the watched run's processes for THIS cluster, across ALL THREE
 * launch modes: the flow direct-CLI form (`node lib/index.js -d
 * <cluster-path>` — cluster path in argv), the flow orchestrator form
 * (`pnpm --filter <pkg> test` with `WIRE_CLUSTER_PATH=<cluster-path>`
 * exported — cluster path ONLY in the environment), and the cluster CLI's
 * `wire-cluster-tool … create|run` form. The env form matches `lib/index.js`
 * candidates by the exact cluster path in `/proc/<pid>/environ`, so
 * concurrent flows in a pooled run stay isolated per monitor.
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<string[]>} matching pids (argv-form ∪ env-form ∪ cluster-CLI).
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
  const cliPids = await clusterCliPids(normalized)
  return [...new Set([...argvPids, ...envHits, ...cliPids])]
}

/**
 * Whether the watched flow / run-CLI process is still running (any launch
 * mode).
 *
 * @param {string} clusterPath the watched cluster's data dir.
 * @return {Promise<boolean>} true while a matching process exists.
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
 * The bootstrap work a cluster config implies, counted in provisioned identities: producers,
 * batch operators and underwriters, plus each batch operator once more when
 * `batchOperatorUnderwriting` is set — each FUNDED underwriting operator also gets an
 * epoch-zero import credit, an irreversible write, and the mock import and custody backing
 * move behind operator provisioning, inside the measured window. Counting every operator
 * twice, funded or not, keeps the deadline an upper bound.
 *
 * @param {object} config the parsed cluster-config.json.
 * @return {number} the identity count {@link bootstrapDeadlineSeconds} scales by.
 */
export function provisionedIdentityCount(config) {
  const batchOperators = config?.batchOperatorCount ?? 0
  return (
    (config?.producerCount ?? 0) +
    batchOperators +
    (config?.underwriterCount ?? 0) +
    (config?.batchOperatorUnderwriting != null ? batchOperators : 0)
  )
}

/**
 * Read `<cluster-path>/cluster-config.json`: the resolved clio executable
 * (`executables.clio`) and the FIRST PRODUCER's HTTP URL
 * (`bind.nodeop.ports.producers[0].http`) — never bios, whose port stops
 * answering after the Phase 8 producer handoff.
 *
 * Also reports the cluster's PROVISIONED IDENTITY COUNT
 * ({@link provisionedIdentityCount}), which scales the bootstrap deadline — see
 * {@link bootstrapDeadlineSeconds}.
 *
 * And each outpost chain's configured epoch duration (`chainEpochDurations`) —
 * which the chain's `epochcfg` row supersedes once it exists — beside the
 * cluster's `epochDurationSec` (else {@link DefaultEpochDurationSeconds}), the
 * duration of a chain neither names.
 *
 * @param {string} clusterConfigPath absolute path to cluster-config.json.
 * @return {{ clioExecutable: string, producerUrl: string, identityCount: number,
 *   chainEpochDurationSeconds: Record<string, number>, defaultEpochDurationSeconds: number } | null}
 *   null while the config is absent or not yet fully written (the pre-config
 *   window).
 */
function readClusterConfig(clusterConfigPath) {
  if (!fs.existsSync(clusterConfigPath)) return null
  try {
    const config = fs.readJsonSync(clusterConfigPath)
    const clioExecutable = config?.executables?.clio
    const producerHttpPort = config?.bind?.nodeop?.ports?.producers?.[0]?.http
    if (clioExecutable == null || producerHttpPort == null) return null
    const identityCount = provisionedIdentityCount(config)
    // Dial the producer at its bind address, mapping the non-dialable listen
    // wildcard (0.0.0.0 / empty) to loopback — mirrors netUtils.toDialAddress
    // (this script is outside the eslint/TS surface, so the mapping is inline).
    const nodeopAddress = config?.bind?.nodeop?.address
    const producerHost =
      nodeopAddress == null ||
      nodeopAddress === "0.0.0.0" ||
      nodeopAddress === ""
        ? Localhost
        : nodeopAddress
    return {
      clioExecutable,
      producerUrl: `http://${producerHost}:${producerHttpPort}`,
      identityCount,
      chainEpochDurationSeconds: chainEpochDurations(config),
      defaultEpochDurationSeconds: config?.epochDurationSec ?? DefaultEpochDurationSeconds
    }
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
 * The row values of a COMPLETE `clio get table` read (v6 `{key, value}` rows unwrapped,
 * {@link kvRowValue}): null when the probe failed, the output does not parse or carries no rows,
 * or the read was truncated at its limit (`more` set), so a probe never counts a partial table.
 *
 * @param {string | null} stdout the read's stdout, or null when the probe failed.
 * @return {object[] | null} the row values, or null unless the read is complete.
 */
export function completeTableValues(stdout) {
  const result = stdout == null ? null : parseJson(stdout)
  return Array.isArray(result?.rows) && result.more !== true ? result.rows.map(kvRowValue) : null
}

/**
 * `clio get table <code> <table> -S <scope> -l <limit>` → the row values of a COMPLETE read
 * ({@link completeTableValues}).
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @param {string} code contract account owning the table.
 * @param {string} table table name.
 * @param {string} scope table scope (v6 `-S` form).
 * @param {number} limit row limit.
 * @return {Promise<object[] | null>} the row values, or null unless the read is complete.
 */
async function clioGetCompleteTableValues(clioExecutable, url, code, table, scope, limit) {
  return completeTableValues(
    await runClio(clioExecutable, url, ["get", "table", code, table, "-S", scope, "-l", String(limit)])
  )
}

/**
 * Probe 1 — chain liveness: `clio get info` → head block AND last-irreversible
 * block. BOTH are reported because a frozen LIB under an advancing head is a
 * distinct, silent failure the head alone cannot show: when finalizers lock on
 * a fork they cast only weak votes, no QC forms, and LIB stops dead while
 * blocks keep being produced. Every `pushActionAndWait` at irreversible
 * finality then hangs forever, so a bootstrap dies with a healthy-looking head.
 * (2026-08-04, 21-producer create: head ~765 with LIB pinned at 584 across all
 * 21 nodes — invisible on a head-only heartbeat.)
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<{ headBlockNumber: number, libBlockNumber: number, headBlockTimeMs: number | null } | null>}
 *   the head + LIB block numbers and the head block's time (the depot's clock every
 *   `due_at` is measured against; null when unparseable), or null while unreachable.
 */
async function probeChainLiveness(clioExecutable, url) {
  const stdout = await runClio(clioExecutable, url, ["get", "info"])
  if (stdout == null) return null
  const info = parseJson(stdout),
    headBlockNumber = info?.head_block_num,
    libBlockNumber = info?.last_irreversible_block_num
  if (typeof headBlockNumber !== "number") return null
  return {
    headBlockNumber,
    libBlockNumber: typeof libBlockNumber === "number" ? libBlockNumber : 0,
    headBlockTimeMs: timePointMs(info?.head_block_time)
  }
}

/**
 * Probe 2 — operators summary (account / status / balance count). Queried on
 * every beat per the rule; NOT printed on the heartbeat line itself — it decides whose
 * backlog reports count ({@link chainEligibleOperators}). Extend here
 * when a flow needs an operator-status red flag (e.g. "operator under test UNKNOWN with
 * balance_count < required_chains").
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<Array<{ account: string, status: string, balanceCount: number }> | null>}
 *   one summary per operator, or null while the table cannot be read completely (a partial read
 *   would drop ACTIVE members from an eligible set).
 */
async function probeOperators(clioExecutable, url) {
  const operators = await clioGetCompleteTableValues(
    clioExecutable, url, SysioOpregAccount, OperatorsTable, SysioOpregAccount, MembershipRowLimit
  )
  if (operators == null) return null
  return operators.map(operator => ({
    account: operator?.account,
    status: operator?.status,
    balanceCount: operator?.balances?.length ?? 0
  }))
}

/**
 * Probe 3 — every outpost chain's `sysio.epoch::epochstate` row, including chain
 * timestamps and the pause flag.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<Record<string, object> | null>} each chain's epoch row keyed by
 *   its codename ({@link chainEpochStates}), or null while the table doesn't exist
 *   yet (pre-bootstrap) or the probe fails.
 */
async function probeEpochStates(clioExecutable, url) {
  const rows = await clioGetTableRows(
    clioExecutable, url, SysioEpochAccount, EpochStateTable, SysioEpochAccount, EpochStateRowLimit
  )
  return rows == null ? null : chainEpochStates(rows)
}

/**
 * Probe 3 (durations) — every outpost chain's `sysio.epoch::epochcfg` row: the
 * depot's own epoch duration of each chain, the source of truth once the chain's
 * `setconfig` ran.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<Record<string, object> | null>} each chain's config row keyed by
 *   its codename (`chainEpochConfigs`), or null while the table doesn't exist yet
 *   (pre-bootstrap) or the probe fails.
 */
async function probeEpochConfigs(clioExecutable, url) {
  const rows = await clioGetTableRows(
    clioExecutable, url, SysioEpochAccount, EpochConfigTable, SysioEpochAccount, EpochStateRowLimit
  )
  return rows == null ? null : chainEpochConfigs(rows)
}

/**
 * Each outpost chain's configured epoch duration: its `epochcfg` row's
 * `epoch_duration_sec` once the row exists, else the cluster-config duration its
 * bootstrap will write there.
 *
 * @param {Record<string, number>} configuredDurations each chain's cluster-config
 *   duration (`chainEpochDurations`).
 * @param {Record<string, object>} epochConfigs each chain's `epochcfg` row
 *   (`chainEpochConfigs`).
 * @return {Record<string, number>} each known chain's duration in seconds, by codename.
 */
export function resolveChainEpochDurations(configuredDurations, epochConfigs) {
  return {
    ...configuredDurations,
    ...Object.fromEntries(
      Object.entries(epochConfigs ?? {}).map(([chain, config]) => [chain, config.epoch_duration_sec])
    )
  }
}

/**
 * The outpost chains the monitor watches, in codename order: every chain the
 * cluster config names, has an `epochcfg` row, or has an `epochstate` row — so a
 * chain configured on the depot but not yet started is still watched for its
 * bootstrap.
 *
 * @param {Record<string, number>} configuredDurations each chain's cluster-config duration.
 * @param {Record<string, object>} epochConfigs each chain's `epochcfg` row.
 * @param {Record<string, object>} epochStates each chain's `epochstate` row.
 * @return {string[]} the chains' codenames, sorted.
 */
export function monitoredChains(configuredDurations, epochConfigs, epochStates) {
  return [
    ...new Set([
      ...Object.keys(configuredDurations ?? {}),
      ...Object.keys(epochConfigs ?? {}),
      ...Object.keys(epochStates ?? {})
    ])
  ].sort()
}

/**
 * One chain's epoch duration: the explicit `--epoch-duration-seconds` override,
 * else its configured duration ({@link resolveChainEpochDurations}), else the
 * cluster's default duration.
 *
 * @param {Record<string, number>} durations each chain's configured duration.
 * @param {string} chain the chain's codename.
 * @param {number | null} overrideSeconds the explicit override, if given.
 * @param {number} defaultSeconds the cluster's `epochDurationSec`, else {@link DefaultEpochDurationSeconds}.
 * @return {number} the duration in seconds.
 */
export function chainEpochDurationSeconds(durations, chain, overrideSeconds, defaultSeconds) {
  return overrideSeconds ?? durations?.[chain] ?? defaultSeconds
}

/**
 * When a chain may next advance (`epochstate.due_at`) in epoch ms on the depot's clock, or null
 * while it has no traffic (a zero `time_point`) or the cell is absent or does not parse — a
 * deadline that cannot be read is never measured against ({@link chainTraffic} tells the two
 * apart).
 *
 * @param {object} state the chain's epoch row.
 * @return {number | null} the chain's `due_at` (ms), or null with no readable deadline.
 */
export function chainDueAtMs(state) {
  const dueAt = timePointMs(state?.due_at)
  return dueAt == null || dueAt === 0 ? null : dueAt
}

/**
 * A started chain's traffic at the depot head ({@link ChainTraffic}): `idle` with a zero
 * `due_at`, `unknown` when its `due_at` is absent or does not parse (fail closed: never idle),
 * `due` once the head has reached it, else `waiting`. Null before the chain's genesis advance
 * (which needs no traffic) or without a row; a chain with traffic reads `waiting` while the
 * head time is unknown, so an unknown clock never makes it due.
 *
 * @param {object} state the chain's epoch row.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @return {string | null} the chain's {@link ChainTraffic} value, or null.
 */
export function chainTraffic(state, headBlockTimeMs) {
  if (state == null || !(state.current_epoch_index >= 1)) return null
  const dueAt = timePointMs(state.due_at)
  if (dueAt == null) return ChainTraffic.unknown
  if (dueAt === 0) return ChainTraffic.idle
  return headBlockTimeMs != null && headBlockTimeMs >= dueAt ? ChainTraffic.due : ChainTraffic.waiting
}

/**
 * How long a chain has been due at the depot head (s): head time minus `due_at`, negative
 * while still waiting. Null while the chain is idle, before its genesis, or with the head time
 * unknown — an idle chain is never overdue.
 *
 * @param {object} state the chain's epoch row.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @return {number | null} the seconds past `due_at`, or null.
 */
export function chainOverdueSeconds(state, headBlockTimeMs) {
  const dueAt = chainDueAtMs(state)
  return dueAt == null || headBlockTimeMs == null || !(state?.current_epoch_index >= 1)
    ? null
    : (headBlockTimeMs - dueAt) / 1000
}

/**
 * The chains due for at least `graceSeconds` ({@link chainOverdueSeconds}), in watch order —
 * the chains whose silence is a liveness signal.
 *
 * @param {string[]} chains the watched chains.
 * @param {Record<string, object>} states each chain's epoch row.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @param {number} graceSeconds how long a chain must have been due.
 * @return {string[]} the overdue chains.
 */
export function overdueChains(chains, states, headBlockTimeMs, graceSeconds) {
  return chains.filter(chain => {
    const overdue = chainOverdueSeconds(states?.[chain], headBlockTimeMs)
    return overdue != null && overdue >= graceSeconds
  })
}

/**
 * Every outpost chain's epoch, in codename order, for the heartbeat line —
 * `ETHEREUM:4i,SOLANA:2pdu` (`p`: the chain is paused; then its {@link chainTraffic}:
 * `i` idle, `w` waiting for its `due_at`, `d` due, `?` unknown; then `u` while its current
 * epoch is undecided — marked only when the beat read `outpcons`).
 *
 * @param {Record<string, object>} states each chain's epoch row.
 * @param {string[]} chains the chains to list.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @param {Record<string, object> | null} consensus each chain's `outpcons` row, or null when the
 *   beat could not read them.
 * @return {string} the fragment, `?` for a chain without a row.
 */
export function describeChainEpochs(states, chains, headBlockTimeMs = null, consensus = null) {
  return chains.length === 0
    ? "?"
    : chains
        .map(chain => {
          const state = states?.[chain],
            traffic = chainTraffic(state, headBlockTimeMs),
            undecided = traffic != null && consensus != null && !isCurrentEpochDecided(state, consensus[chain])
          return (
            `${chain}:${state?.current_epoch_index ?? "?"}${state?.is_paused === true ? "p" : ""}` +
            `${traffic == null ? "" : ChainTrafficMarks[traffic]}${undecided ? UndecidedMark : ""}`
          )
        })
        .join(",")
}

/**
 * Whether a table cell holds `member` of a generated contract enum, in any spelling the RPC
 * renders it: the number, its decimal string, or the member's name.
 *
 * @param {unknown} cell the cell.
 * @param {Record<string | number, string | number>} enumObject the generated enum.
 * @param {number} member the member's value.
 * @return {boolean} true when the cell holds the member.
 */
function isEnumMember(cell, enumObject, member) {
  return cell === member || cell === enumObject[member] || (typeof cell === "string" && Number(cell) === member)
}

/**
 * The codename a `slug_name` cell names (`servchains.chain_code`): the ABI renders the spelling
 * itself, or the packed value as a number or quoted decimal.
 *
 * @param {unknown} cell the cell.
 * @return {string | null} the codename, or null when the cell names no chain.
 */
export function slugCellCodename(cell) {
  return typeof cell === "string" && !/^\d+$/.test(cell) ? cell : chainCodename(cell)
}

/**
 * A chain's group on duty: `epochstate.batch_op_groups[current_batch_op_group]`, the seats its
 * backlog reports are tallied over.
 *
 * @param {object} state the chain's epoch row.
 * @return {string[] | null} the group's accounts, one per seat, or null when the row carries none.
 */
export function chainGroupOnDuty(state) {
  const group = state?.batch_op_groups?.[state?.current_batch_op_group]
  return Array.isArray(group) ? group : null
}

/**
 * A chain's next group: `epochstate.batch_op_groups[current_batch_op_group + 1]`, the group the next
 * advance puts on duty, whose backlog reports `sysio.msgch` tallies over its own seats.
 *
 * @param {object} state the chain's epoch row.
 * @return {string[] | null} the group's accounts, one per seat, or null when the window holds none.
 */
export function chainNextGroup(state) {
  const cursor = state?.current_batch_op_group,
    group = Number.isInteger(cursor) ? state?.batch_op_groups?.[cursor + 1] : undefined
  return Array.isArray(group) ? group : null
}

/**
 * The members of a chain's group on duty ({@link chainGroupOnDuty}) and of its next group
 * ({@link chainNextGroup}) whose backlog reports `sysio.msgch` counts: those ACTIVE in
 * `sysio.opreg::operators` holding a membership of the chain that is not EVICTED. Null when the
 * beat could not read the operators or the memberships, or the chain has no group on duty.
 *
 * @param {object} state the chain's epoch row.
 * @param {Array<{ account: string, status: unknown }> | null} operators the operators probe.
 * @param {object[] | null} memberships the `servchains` rows.
 * @param {string} chain the chain's codename.
 * @return {string[] | null} the eligible accounts, or null when unknown.
 */
export function chainEligibleOperators(state, operators, memberships, chain) {
  const onDuty = chainGroupOnDuty(state)
  if (operators == null || memberships == null || onDuty == null) return null
  const group = [...onDuty, ...(chainNextGroup(state) ?? [])],
    { SysioOpregOperatorstatus, SysioOpregChainServiceStatus } = SysioContracts,
    isActive = account =>
      operators.some(
        operator =>
          operator.account === account &&
          isEnumMember(operator.status, SysioOpregOperatorstatus, SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE)
      ),
    deliversOnChain = account =>
      memberships.some(
        membership =>
          membership.account === account &&
          slugCellCodename(membership.chain_code) === chain &&
          !isEnumMember(membership.status, SysioOpregChainServiceStatus, SysioOpregChainServiceStatus.EVICTED)
      )
  return group.filter(account => isActive(account) && deliversOnChain(account))
}

/**
 * One group's backlog reports of a chain in its current epoch, as `sysio.msgch` tallies them: the
 * group's eligible members ({@link chainEligibleOperators}) with a `qreports` row of the chain in
 * its current epoch, over every seat of the group — a slashed, evicted or inactive member never
 * lowers the strict majority of seats whose reports record the chain's traffic.
 *
 * @param {object[]} reports every `qreports` row.
 * @param {object} state the chain's epoch row.
 * @param {string} chain the chain's codename.
 * @param {string[] | null} eligible the chain's eligible accounts, or null when unknown.
 * @param {string[] | null} group the group tallied: its group on duty unless given; null when the
 *   row carries none, which counts every eligible report.
 * @return {{ reporters: number | null, seats: number | null }} the reporters (null while the
 *   eligible set is unknown) and the seats (null without the group).
 */
export function chainBacklogReports(reports, state, chain, eligible, group = chainGroupOnDuty(state)) {
  const reporters =
      eligible == null
        ? null
        : reports.filter(
            report =>
              chainCodename(report?.chain_code) === chain &&
              Number(report?.epoch_index) === state.current_epoch_index &&
              eligible.includes(report.account) &&
              (group == null || group.includes(report.account))
          ).length,
    seats = group?.length ?? null
  return { reporters, seats }
}

/**
 * Every watched chain's current-epoch backlog reports, for the heartbeat line —
 * `ETHEREUM:2/3+0/3,SOLANA:0/3` (reporters / seats of the group on duty, then `+` those of the next
 * group when the window holds one, {@link chainBacklogReports}); `?` for an unknown count, and for a
 * chain before its genesis advance or without a row.
 *
 * @param {string[]} chains the watched chains.
 * @param {Record<string, object>} states each chain's epoch row.
 * @param {object[] | null} reports every `qreports` row, or null when unread.
 * @param {Record<string, string[] | null>} eligibleByChain each chain's eligible accounts.
 * @return {string} the fragment; `?` when the reports were not read or no chain is watched.
 */
export function describeBacklogReports(chains, states, reports, eligibleByChain) {
  if (reports == null || chains.length === 0) return "?"
  return chains
    .map(chain => {
      const state = states?.[chain]
      if (!(state?.current_epoch_index >= 1)) return `${chain}:?`
      const eligible = eligibleByChain?.[chain],
        describe = ({ reporters, seats }) => `${reporters ?? "?"}/${seats ?? "?"}`,
        next = chainNextGroup(state),
        onDuty = describe(chainBacklogReports(reports, state, chain, eligible))
      return next == null
        ? `${chain}:${onDuty}`
        : `${chain}:${onDuty}+${describe(chainBacklogReports(reports, state, chain, eligible, next))}`
    })
    .join(",")
}

/**
 * Bootstrap deadline: a chain's epoch must reach >= 1 within this many seconds
 * of first chain liveness. Scaled by the cluster's provisioned identity count
 * (see {@link BootstrapPerIdentitySeconds}) because a 21-producer / 21-batch-op
 * bootstrap legitimately takes many times longer than the dev default's — a
 * flat floor would SIGINT it mid-bootstrap — and by the chain's own duration.
 *
 * @param {number} identityCount the provisioned identity count — see
 *   {@link provisionedIdentityCount}.
 * @param {number} durationSeconds the chain's epoch duration.
 * @return {number} the deadline, in seconds of chain liveness.
 */
export function bootstrapDeadlineSeconds(identityCount, durationSeconds) {
  return Math.max(
    BootstrapDeadlineFloorSeconds,
    durationSeconds * BootstrapDeadlineEpochs,
    identityCount * BootstrapPerIdentitySeconds
  )
}

/**
 * The bootstrap-never-completed bail reason: the first watched chain whose epoch
 * is still null/0 past its own deadline ({@link bootstrapDeadlineSeconds}), or —
 * when the monitor knows of no chain at all — the absence of any epochstate row
 * past the deadline of `noChainDurationSeconds`.
 *
 * @param {string[]} chains the watched chains ({@link monitoredChains}).
 * @param {Record<string, number | undefined>} epochIndices each chain's epoch index this beat.
 * @param {number} livenessSeconds seconds since the chain first answered.
 * @param {number} identityCount the provisioned identity count.
 * @param {(chain: string) => number} durationSeconds a chain's monitored duration.
 * @param {number} noChainDurationSeconds the duration the deadline scales by when
 *   no chain is known (the override, else the cluster's `epochDurationSec`).
 * @return {string | null} the bail reason, or null while no deadline has passed.
 */
export function bootstrapBailReason(
  chains, epochIndices, livenessSeconds, identityCount, durationSeconds, noChainDurationSeconds
) {
  const provisioned = `for ${identityCount} provisioned identities`
  if (chains.length === 0) {
    const deadlineSeconds = bootstrapDeadlineSeconds(identityCount, noChainDurationSeconds)
    return livenessSeconds > deadlineSeconds
      ? `bootstrap never completed: ${NoEpochStateLabel} after ${livenessSeconds}s of chain liveness ` +
          `(deadline ${deadlineSeconds}s ${provisioned})`
      : null
  }
  const overdue = chains
    .filter(chain => epochIndices[chain] == null || epochIndices[chain] === 0)
    .find(chain => livenessSeconds > bootstrapDeadlineSeconds(identityCount, durationSeconds(chain)))
  return overdue == null
    ? null
    : `bootstrap never completed: ${overdue} current_epoch_index=${epochIndices[overdue] ?? "null"} ` +
        `after ${livenessSeconds}s of chain liveness ` +
        `(deadline ${bootstrapDeadlineSeconds(identityCount, durationSeconds(overdue))}s ${provisioned})`
}

/**
 * Whether a DUE chain that showed the same epoch as the previous beat should be
 * re-probed for a stall now: its time past `due_at` plus the re-probe delay
 * reaches {@link EpochStallDurations} of its own minimum duration. At a 60 s
 * minimum a chain 75 s past due qualifies (75 + 45 >= 120). An idle chain
 * (null overdue time) is never re-probed.
 *
 * @param {number | null} overdueSeconds seconds the chain has been due ({@link chainOverdueSeconds}).
 * @param {number} durationSeconds the chain's minimum epoch duration.
 * @return {boolean} true when the re-probe is due.
 */
export function isStallReprobeDue(overdueSeconds, durationSeconds) {
  return (
    overdueSeconds != null &&
    overdueSeconds + EpochStallReprobeDelaySeconds >= EpochStallDurations * durationSeconds
  )
}

/**
 * The chains due a stall re-probe this beat: each due chain at the same epoch as
 * the previous beat whose re-probe is due ({@link isStallReprobeDue}).
 *
 * @param {string[]} chains the watched chains.
 * @param {Record<string, number | undefined>} epochIndices each chain's epoch index this beat.
 * @param {Record<string, number>} previousEpochIndices each chain's index at the previous beat.
 * @param {(chain: string) => number | null} overdueSeconds seconds a chain has been due, null while idle.
 * @param {(chain: string) => number} durationSeconds a chain's monitored duration.
 * @return {string[]} the due chains, in watch order.
 */
export function stallReprobeDueChains(chains, epochIndices, previousEpochIndices, overdueSeconds, durationSeconds) {
  return chains.filter(
    chain =>
      epochIndices[chain] != null &&
      epochIndices[chain] === previousEpochIndices[chain] &&
      isStallReprobeDue(overdueSeconds(chain), durationSeconds(chain))
  )
}

/**
 * Each OPP direction's freeze streak after this beat: a direction whose count did not move
 * while the total advanced grows its streak, but only while EVERY direction has a non-zero
 * baseline and the direction's chain is due — an idle or waiting chain's directions
 * legitimately stand still while the other chain flows. Any other direction resets to 0.
 *
 * @param {Record<string, number>} streaks each direction's streak before this beat.
 * @param {Record<string, number>} previousCounts each direction's count at the previous beat.
 * @param {Record<string, number>} counts each direction's count this beat.
 * @param {number} oppDelta artifacts added since the previous beat.
 * @param {string[]} dueChains the chains due this beat ({@link chainTraffic}).
 * @return {Record<string, number>} each direction's streak after this beat.
 */
export function directionFreezeStreaks(streaks, previousCounts, counts, oppDelta, dueChains) {
  const allDirectionsHaveBaseline = OppDirections.every(direction => counts[direction.name] > 0)
  return Object.fromEntries(
    OppDirections.map(direction => {
      const frozenWhileDue =
        allDirectionsHaveBaseline &&
        oppDelta > 0 &&
        dueChains.includes(direction.chain) &&
        counts[direction.name] === previousCounts[direction.name]
      return [direction.name, frozenWhileDue ? (streaks[direction.name] ?? 0) + 1 : 0]
    })
  )
}

/**
 * The first direction frozen for {@link DirectionFreezeBailStreak} beats, in heartbeat order.
 *
 * @param {Record<string, number>} streaks each direction's streak ({@link directionFreezeStreaks}).
 * @return {string | null} the plateaued direction's name, or null.
 */
export function plateauDirection(streaks) {
  return OppDirections.find(direction => streaks[direction.name] >= DirectionFreezeBailStreak)?.name ?? null
}

/**
 * The first due chain still at its previous epoch after the re-probe — a true
 * stall. A chain the re-probe could not read keeps its beat index, so a failed
 * re-probe never clears a stall.
 *
 * @param {string[]} dueChains the chains re-probed ({@link stallReprobeDueChains}).
 * @param {Record<string, object>} reprobedStates each chain's re-probed epoch row.
 * @param {Record<string, number | undefined>} epochIndices each chain's epoch index this beat.
 * @param {Record<string, number>} previousEpochIndices each chain's index at the previous beat.
 * @return {string | undefined} the stalled chain, or undefined when every due chain advanced.
 */
export function stalledChain(dueChains, reprobedStates, epochIndices, previousEpochIndices) {
  return dueChains.find(
    chain =>
      (reprobedStates?.[chain]?.current_epoch_index ?? epochIndices[chain]) === previousEpochIndices[chain]
  )
}

/**
 * The network's first-epoch growth deadline: the latest of every chain's
 * {@link firstEpochGrowthDeadlineMs}, so zero growth is tolerated until every
 * chain is one minimum past its genesis advance. Null while any chain has not
 * started.
 *
 * @param {Record<string, object>} states each chain's epoch row.
 * @param {string[]} chains the chains the network runs.
 * @param {(chain: string) => number} durationSeconds a chain's monitored duration.
 * @return {number | null} the deadline (ms), or null before every chain started.
 */
export function networkGrowthDeadlineMs(states, chains, durationSeconds) {
  const deadlines = chains.map(chain => firstEpochGrowthDeadlineMs(states?.[chain], durationSeconds(chain)))
  return chains.length === 0 || deadlines.some(deadline => deadline == null) ? null : Math.max(...deadlines)
}

/**
 * Whether the depot head stood still across a beat: the same block number at the previous beat
 * and at this one, both read. A beat whose probe failed (null) is never a frozen head.
 *
 * @param {number | null} previousHeadBlockNumber the head at the previous beat.
 * @param {number | null} headBlockNumber the head at this beat.
 * @return {boolean} true when both beats read the same head.
 */
export function isHeadFrozen(previousHeadBlockNumber, headBlockNumber) {
  return previousHeadBlockNumber != null && headBlockNumber != null && headBlockNumber === previousHeadBlockNumber
}

/**
 * The head-advance bail reason: the head stood still across a beat ({@link isHeadFrozen}) and
 * the re-probe, {@link HeadStallReprobeDelaySeconds} later on the monitor's wall clock, still
 * reads it there. A failed re-probe keeps the beat's head, so it never clears the bail. Chain
 * traffic plays no part: a stopped producer freezes the head time every `due_at` is measured on,
 * so a due chain and an idle one look alike there.
 *
 * @param {number | null} previousHeadBlockNumber the head at the previous beat.
 * @param {number | null} headBlockNumber the head at this beat.
 * @param {number | null} reprobedHeadBlockNumber the head at the re-probe, null when it failed.
 * @param {number} beatSeconds the wall-clock seconds between the two beats.
 * @return {string | null} the bail reason, or null while the head advances.
 */
export function headStallBailReason(previousHeadBlockNumber, headBlockNumber, reprobedHeadBlockNumber, beatSeconds) {
  if (!isHeadFrozen(previousHeadBlockNumber, headBlockNumber)) return null
  const reprobed = reprobedHeadBlockNumber ?? headBlockNumber
  return reprobed === previousHeadBlockNumber
    ? `depot head frozen at block ${previousHeadBlockNumber} for ${beatSeconds + HeadStallReprobeDelaySeconds}s of wall clock ` +
        `(${HeadStallReprobeDelaySeconds}s re-probe included): the producers stopped`
    : null
}

/**
 * How long a chain's current epoch may stay undecided (s) before it is a stall:
 * `max(UndecidedEpochFloorSeconds, UndecidedEpochDurations × minimum)`.
 *
 * @param {number} durationSeconds the chain's minimum epoch duration.
 * @return {number} the allowance in seconds.
 */
export function undecidedEpochAllowanceSeconds(durationSeconds) {
  return Math.max(UndecidedEpochFloorSeconds, UndecidedEpochDurations * durationSeconds)
}

/**
 * The instant (ms, depot clock) a chain's current epoch has been undecided since, for the
 * undecided-epoch bail: carried over while the chain stays in the epoch the previous beat saw;
 * the epoch's `current_epoch_start` once the monitor saw the chain move into it; and, on the
 * first beat that sees the chain at all (a monitor attached late, or a relaunched cluster whose
 * head jumped past its downtime), the later of that start and the beat's head time — a downtime
 * is not undecided time.
 *
 * @param {{ epochIndex: number, sinceMs: number } | undefined} previous the chain's record from
 *   the previous beat, absent on the first.
 * @param {object} state the chain's epoch row.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @return {{ epochIndex: number, sinceMs: number } | null} the chain's record for this beat, or
 *   null without a row or a readable start.
 */
export function undecidedEpochSince(previous, state, headBlockTimeMs) {
  const epochIndex = state?.current_epoch_index,
    startMs = timePointMs(state?.current_epoch_start)
  if (epochIndex == null || startMs == null) return null
  if (previous != null && previous.epochIndex === epochIndex) return previous
  const sinceMs = previous == null && headBlockTimeMs != null ? Math.max(startMs, headBlockTimeMs) : startMs
  return { epochIndex, sinceMs }
}

/**
 * The undecided-epoch bail reason: the first watched chain that is started and unpaused, whose
 * current epoch (the genesis epoch included) `outpcons` does not record as decided, and whose
 * undecided time ({@link undecidedEpochSince}, on the depot head clock) exceeds its
 * {@link undecidedEpochAllowanceSeconds}. Never fires while the beat could not read `outpcons`
 * or the head time, nor with `--expect-epoch-freeze`. A paused chain is skipped: a dispute holds
 * it undecided on purpose.
 *
 * @param {string[]} chains the watched chains.
 * @param {Record<string, object>} states each chain's epoch row.
 * @param {Record<string, object> | null} consensus each chain's `outpcons` row, or null when unread.
 * @param {Record<string, { epochIndex: number, sinceMs: number }>} undecidedSince each chain's record.
 * @param {number | null} headBlockTimeMs the depot head block's time (ms).
 * @param {(chain: string) => number} durationSeconds a chain's monitored duration.
 * @param {boolean} expectEpochFreeze whether the flow deliberately holds an epoch.
 * @return {string | null} the bail reason, or null.
 */
export function undecidedEpochBailReason(
  chains, states, consensus, undecidedSince, headBlockTimeMs, durationSeconds, expectEpochFreeze = false
) {
  if (expectEpochFreeze || consensus == null || headBlockTimeMs == null) return null
  const undecidedSeconds = chain => (headBlockTimeMs - undecidedSince[chain].sinceMs) / 1000
  const stalled = chains.find(chain => {
    const state = states?.[chain]
    return (
      state != null &&
      state.current_epoch_index >= 1 &&
      state.is_paused !== true &&
      undecidedSince?.[chain] != null &&
      !isCurrentEpochDecided(state, consensus[chain]) &&
      undecidedSeconds(chain) > undecidedEpochAllowanceSeconds(durationSeconds(chain))
    )
  })
  return stalled == null
    ? null
    : `${stalled} epoch ${states[stalled].current_epoch_index} undecided for ${Math.round(undecidedSeconds(stalled))}s ` +
        `(allowance ${undecidedEpochAllowanceSeconds(durationSeconds(stalled))}s; ` +
        `outpcons last decided ${consensus[stalled]?.epoch_index ?? "none"})`
}

/**
 * Probe 3 (consensus) — every outpost chain's `sysio.msgch::outpcons` row: the epoch whose
 * winner the depot accepted last on each chain.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<Record<string, object> | null>} each chain's row keyed by its codename
 *   (`chainOutpostConsensus`), or null while the table cannot be read.
 */
async function probeOutpostConsensus(clioExecutable, url) {
  const rows = await clioGetTableRows(
    clioExecutable, url, SysioMsgchAccount, OutpostConsensusTable, SysioMsgchAccount, EpochStateRowLimit
  )
  return rows == null ? null : chainOutpostConsensus(rows)
}

/**
 * Probe 3 (backlog) — every `sysio.msgch::qreports` row: each batch operator's latest report of an
 * outpost's outbound backlog (`sysio.msgch::reportqueue`), with the chain epoch it was made in.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<object[] | null>} the report rows (v6 values unwrapped), or null while the
 *   table cannot be read completely.
 */
async function probeQueueReports(clioExecutable, url) {
  return clioGetCompleteTableValues(
    clioExecutable, url, SysioMsgchAccount, QueueReportsTable, SysioMsgchAccount, MembershipRowLimit
  )
}

/**
 * Probe 3 (memberships) — every `sysio.opreg::servchains` row: each batch operator's membership
 * of each outpost chain it joined, which decides whether it delivers on (and reports for) it.
 *
 * @param {string} clioExecutable resolved clio binary.
 * @param {string} url the producer HTTP URL.
 * @return {Promise<object[] | null>} the membership rows (v6 values unwrapped), or null while
 *   the table cannot be read completely.
 */
async function probeServedChains(clioExecutable, url) {
  return clioGetCompleteTableValues(
    clioExecutable, url, SysioOpregAccount, ServedChainsTable, SysioOpregAccount, MembershipRowLimit
  )
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
 * Probe top-N action receipts, FATAL count/tail and NOISE count/last reason.
 * Stream failure classification one line at a time, retaining only the tails;
 * expected refusals can coexist with unrelated failures on the same line.
 *
 * @param {string} clusterLogFile the aggregate cluster log path.
 * @param {boolean} expectFreeze whether this run deliberately freezes outposts.
 * @return {Promise<{ actionReceipts: string[], fatalCount: number, fatalTail: string[], noiseCount: number, noiseTail: string }>}
 *   the parsed probe result.
 */
export async function probeAggregateLog(clusterLogFile, expectFreeze = false) {
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

  const result = { ...emptyLogProbe(), actionReceipts }
  const fatalPattern = new RegExp(FatalSignaturePattern)
  const fatalExcludePattern = new RegExp(FatalExcludePattern)
  const echoPattern = new RegExp(EchoWrapperExcludePattern)
  const noisePattern = new RegExp(NoiseSignaturePattern)
  const noiseTailPattern = new RegExp(`(?:${NoiseTailSourcePattern}).*`)
  const lines = createInterface({ input: fs.createReadStream(clusterLogFile), crlfDelay: Infinity })
  for await (const line of lines) {
    if (echoPattern.test(line)) continue
    const freeze = line.match(FreezeRefusalPattern)
    const residual = expectFreeze ? line.replace(FreezeFailurePattern, "") : line
    if ((!expectFreeze && freeze != null) ||
        (fatalPattern.test(residual) && !fatalExcludePattern.test(residual))) {
      result.fatalCount++
      result.fatalTail.push(line)
      if (result.fatalTail.length > FatalTailLines) result.fatalTail.shift()
    }
    if (noisePattern.test(line) || (expectFreeze && freeze != null)) {
      result.noiseCount++
      const reason = expectFreeze && freeze != null ? freeze[0] : line.match(noiseTailPattern)?.[0]
      if (reason != null) result.noiseTail = reason.slice(0, NoiseTailMaxLength)
    }
  }
  return result
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
  --epoch-duration-seconds <n>   every outpost chain's minimum epoch duration (default:
                                 each chain's sysio.epoch::epochcfg epoch_duration_sec,
                                 read every beat; its cluster-config
                                 outpostEpochDurationSec until that row exists);
                                 scales each chain's bootstrap-deadline bail and its
                                 epoch-stall grace past due_at
  --expect-freeze                ONLY flow-emergency-stop: exact OutpostFrozen
                                 (0x17c7), EnforcedPause and NoPendingDesyndication
                                 recovery refusals become NOISE.
                                 Default FATAL. All liveness bails remain enabled.
  --expect-epoch-freeze          the flow INTENTIONALLY holds a chain that is due as its
                                 mechanism (flow-batch-operator-slashing holds the
                                 contested chain's epoch across the dispute lifecycle;
                                 flow-economic-clock and flow-per-chain-epochs pause
                                 Ethereum's epoch while Solana is kept due);
                                 suppresses the epoch-stall / undecided-epoch /
                                 opp-zero-growth / direction-plateau bails (FATAL,
                                 bootstrap and head-advance bails still fire: a pause
                                 freezes epochs, never blocks). Default off. An IDLE
                                 chain (no traffic) needs no flag: idle is never a stall.
  -h, --help                     print this usage

${chalk.bold("Output")} (line-oriented on stdout; each line is a Monitor event):
  HB t=<s> head=<n> lib=<n>(-<gap>) epoch=<CHAIN>:<n>[p][i|w|d|?][u],... qreports=<CHAIN>:<r>/<s>[+<r>/<s>],... env=<n> opp=<total> Δ=<delta> dirs: D>E=<n> E>D=<n> D>S=<n> S>D=<n> acts=[...] fatal=<n>(+<d>) noise=<n>(+<d>)
                            (one epoch per outpost chain; p = paused; i = idle, no
                            traffic, never a stall; w = traffic, waiting for due_at;
                            d = due, must advance; ? = due_at unreadable, never idle;
                            u = current epoch still undecided; qreports = each chain's
                            backlog reporters / its group's seats in its current epoch,
                            then + those of its next group)
  Liveness bails beside the epoch ones: the depot head block frozen across a beat and
                            a ${HeadStallReprobeDelaySeconds}s re-probe (wall clock); a chain's epoch undecided past
                            max(${UndecidedEpochFloorSeconds}s, ${UndecidedEpochDurations} x its minimum)
  growth=first-epoch-boundary(until=<UTC>): zero delta before every chain's first
                            epoch start + configured duration; reported without a bail.
                            Past it, zero delta bails only while a chain has been due
                            for a whole beat
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

/**
 * Establish the one-time initial growth boundary from chain time, never the
 * monitor's observation time: the chain's genesis epoch start plus its
 * minimum duration (the genesis round trip ships with no traffic). A late
 * attachment at epoch > 1 is already past the first epoch; a missing or
 * unparseable start fails closed rather than grant new grace.
 *
 * @param {object} epochState the chain's epoch row.
 * @param {number} epochDurationSeconds the chain's monitored minimum duration.
 * @return {number | null} the deadline (ms), 0 past the first epoch, or null before
 *   the chain started.
 */
export function firstEpochGrowthDeadlineMs(epochState, epochDurationSeconds) {
  const index = epochState?.current_epoch_index
  if (index == null || index < 1) return null
  if (index > 1) return 0
  const start = timePointMs(epochState.current_epoch_start)
  return start == null ? 0 : start + epochDurationSeconds * 1000
}

/**
 * Self-check 6 under depot pacing: mark the initial partial-epoch cycle, then
 * bail on a zero-growth cycle at/past its chain-time boundary ONLY while some
 * chain has been due for a whole beat (`overdue`) — an idle cluster grows no
 * artifacts and is healthy. The caller retains the first deadline across epoch
 * changes. Before the network has started (some chain's epoch still null/0)
 * the bootstrap rule applies instead.
 *
 * @param {boolean} networkStarted whether every watched chain has reached epoch >= 1.
 * @param {number} oppDelta opp-debugging artifacts added since the previous beat.
 * @param {number} oppTotal opp-debugging artifacts in total.
 * @param {number} nowMs the beat's wall clock (ms).
 * @param {number | null} deadlineMs the first-epoch growth deadline (ms), or null
 *   before it is known.
 * @param {boolean} expectEpochFreeze whether the flow deliberately freezes an epoch.
 * @param {string[]} overdue the chains due for at least a beat ({@link overdueChains}).
 * @return {string | null} the bail reason, or null when the beat is healthy.
 */
export function oppGrowthBailReason(
  networkStarted, oppDelta, oppTotal, nowMs, deadlineMs, expectEpochFreeze = false, overdue = []
) {
  if (!networkStarted || oppDelta > 0 || expectEpochFreeze || overdue.length === 0) return null
  if (deadlineMs != null && nowMs < deadlineMs) return null
  return `opp-debugging zero growth (total=${oppTotal}) on a post-bootstrap heartbeat while ${overdue.join(", ")} ` +
    "is due and overdue"
}

/** Run the CLI heartbeat; importing the log probe does not start a monitor. */
async function main() {
  if (argv.help === true || argv.h === true) {
    printUsage()
    process.exit(0)
  }

  const clusterPath = resolveClusterPath()
  const intervalSeconds = resolveNumberOption("interval-seconds", DefaultIntervalSeconds)
  /** The explicit `--epoch-duration-seconds` override of every chain's duration, or null. */
  const epochDurationOverrideSeconds = argv["epoch-duration-seconds"] == null
    ? null
    : resolveNumberOption("epoch-duration-seconds", DefaultEpochDurationSeconds)
  /**
   * `--expect-epoch-freeze`: the watched flow INTENTIONALLY holds a chain that is
   * due as part of its mechanism — flow-batch-operator-slashing holds the
   * contested epoch index across the entire dispute → vote → resolve → slash
   * lifecycle by making the sole active batch-op group SBP-less (it never
   * delivers, so depot consensus cannot advance and the epoch is paused for the
   * dispute), and flow-economic-clock and flow-per-chain-epochs pause Ethereum's
   * consensus epoch through `sysio.epoch::pause` while Solana is kept due.
   * Suppresses the four epoch-ADVANCEMENT bails (epoch-stall, undecided-epoch,
   * opp zero-growth, direction-plateau) that would otherwise false-kill such a
   * flow when the held chain has traffic or an undeliverable group. An idle chain
   * needs no flag: the stall bails only ever fire on a due chain. The
   * FATAL-signature, bootstrap-never-completes and head-advance bails STILL fire
   * — a real plugin/execution failure, or stopped producers, are still caught.
   * Default off.
   */
  const expectEpochFreeze = argv["expect-epoch-freeze"] === true
  const expectFreeze = argv["expect-freeze"] === true

  const clusterConfigPath = path.join(clusterPath, ClusterConfigFilename)
  const oppDebuggingDir = path.join(clusterPath, OppDebuggingSubdir)

  // ---------------------------------------------------------------------------
  // Heartbeat loop
  // ---------------------------------------------------------------------------

  let firstGrowthDeadlineMs = null
  /** Each chain's epoch index at the previous beat, by codename. */
  const previousEpochIndices = {}
  /** Each chain's current epoch and the instant it has been undecided since ({@link undecidedEpochSince}). */
  let undecidedSince = {}
  /** The depot head block number at the previous beat (null when that beat's probe failed). */
  let previousHeadBlockNumber = null
  /** The wall clock (ms) of the previous beat. */
  let previousBeatTimestamp = null
  let previousOppTotal = 0
  let previousFatalCount = 0
  let previousNoiseCount = 0
  let fatalGrowthStreak = 0
  let firstLivenessTimestamp = null
  let previousDirectionCounts = Object.fromEntries(OppDirections.map(direction => [direction.name, 0]))
  let freezeStreaks = Object.fromEntries(OppDirections.map(direction => [direction.name, 0]))
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
    const liveness = await probeChainLiveness(clioExecutable, producerUrl),
      headBlockNumber = liveness?.headBlockNumber,
      libBlockNumber = liveness?.libBlockNumber,
      headBlockTimeMs = liveness?.headBlockTimeMs ?? null
    if (headBlockNumber != null && firstLivenessTimestamp == null) {
      firstLivenessTimestamp = now
    }

    // Probe 2 — operators (queried every beat; unprinted, it decides whose backlog reports
    // count).
    const operators = await probeOperators(clioExecutable, producerUrl)

    // Probe 3 — the outposts' backlog reports and the chain memberships that decide whose count.
    const queueReports = await probeQueueReports(clioExecutable, producerUrl)
    const memberships = await probeServedChains(clioExecutable, producerUrl)

    // Probe 3 — every outpost chain's epoch state, its epoch duration from the
    // depot's epochcfg row (the cluster config's until the row exists), and the
    // epoch each chain decided last (outpcons; null while unreadable).
    const epochStates = (await probeEpochStates(clioExecutable, producerUrl)) ?? {}
    const epochConfigs = (await probeEpochConfigs(clioExecutable, producerUrl)) ?? {}
    const outpostConsensus = await probeOutpostConsensus(clioExecutable, producerUrl)
    const chainDurations = resolveChainEpochDurations(clusterConfig.chainEpochDurationSeconds, epochConfigs)
    const chains = monitoredChains(clusterConfig.chainEpochDurationSeconds, epochConfigs, epochStates)
    const monitoredDuration = chain => chainEpochDurationSeconds(
      chainDurations, chain, epochDurationOverrideSeconds, clusterConfig.defaultEpochDurationSeconds
    )
    const epochIndices = Object.fromEntries(
      chains.map(chain => [chain, epochStates[chain]?.current_epoch_index])
    )
    const eligibleByChain = Object.fromEntries(
      chains.map(chain => [chain, chainEligibleOperators(epochStates[chain], operators, memberships, chain)])
    )
    undecidedSince = Object.fromEntries(
      chains
        .map(chain => [chain, undecidedEpochSince(undecidedSince[chain], epochStates[chain], headBlockTimeMs)])
        .filter(([, record]) => record != null)
    )
    // The network is past bootstrap once EVERY chain has started its epoch 1; the
    // post-bootstrap gates (FATAL tail, FATAL growth, stalls) wait for that.
    const networkStarted = chains.length > 0 && chains.every(chain => epochIndices[chain] >= 1)
    if (firstGrowthDeadlineMs == null) {
      firstGrowthDeadlineMs = networkGrowthDeadlineMs(epochStates, chains, monitoredDuration)
    }
    // Depot pacing: only a DUE chain's silence is a liveness signal; an idle one
    // legitimately stays in its epoch and grows no artifacts.
    const dueChains = chains.filter(chain => chainTraffic(epochStates[chain], headBlockTimeMs) === ChainTraffic.due)
    const overdueForBeat = overdueChains(chains, epochStates, headBlockTimeMs, intervalSeconds)

    // Probe 4 — msgch outbound envelopes.
    const envelopeCount = await probeEnvelopes(clioExecutable, producerUrl)

    // Probe 5 — opp-debugging artifacts + per-direction freeze accounting.
    // A plateau = a direction FROZEN for DirectionFreezeBailStreak consecutive
    // beats while the total advances and its chain is due — evaluated only once
    // EVERY direction has a non-zero baseline. A single same-count beat right
    // after the baselines appear is normal ramp, not a plateau, and an idle
    // chain's directions never count.
    const opp = await probeOppArtifacts(oppDebuggingDir)
    const oppDelta = opp.total - previousOppTotal
    freezeStreaks = directionFreezeStreaks(freezeStreaks, previousDirectionCounts, opp.byDirection, oppDelta, dueChains)
    previousDirectionCounts = { ...opp.byDirection }
    const plateaued = plateauDirection(freezeStreaks)

    // Probe 6 — aggregate cluster log.
    const clusterLogFile = await resolveClusterLogFile(clusterPath)
    const logProbe = clusterLogFile != null ? await probeAggregateLog(clusterLogFile, expectFreeze) : emptyLogProbe()

    const fatalDelta = logProbe.fatalCount - previousFatalCount
    const noiseDelta = logProbe.noiseCount - previousNoiseCount
    previousNoiseCount = logProbe.noiseCount
    fatalGrowthStreak = fatalDelta > 0 ? fatalGrowthStreak + 1 : 0

    const growthNowMs = Date.now()
    const initialEpochBoundary = networkStarted && oppDelta <= 0 &&
      firstGrowthDeadlineMs != null && growthNowMs < firstGrowthDeadlineMs
    const growthMarker = initialEpochBoundary
      ? ` growth=first-epoch-boundary(until=${new Date(firstGrowthDeadlineMs).toISOString()})`
      : ""
    const directionsText = OppDirections.map(
      direction => `${direction.short}=${opp.byDirection[direction.name]}`
    ).join(" ")
    console.log(
      `HB t=${elapsedSeconds}s head=${headBlockNumber ?? "?"} lib=${libBlockNumber ?? "?"}` +
        `(-${headBlockNumber != null && libBlockNumber != null ? headBlockNumber - libBlockNumber : "?"}) ` +
        `epoch=${describeChainEpochs(epochStates, chains, headBlockTimeMs, outpostConsensus)} ` +
        `qreports=${describeBacklogReports(chains, epochStates, queueReports, eligibleByChain)} ` +
        `env=${envelopeCount ?? "?"} opp=${opp.total} Δ=${oppDelta} dirs: ${directionsText} ` +
        `acts=[${logProbe.actionReceipts.join(" ")}] ` +
        `fatal=${logProbe.fatalCount}(+${fatalDelta}) noise=${logProbe.noiseCount}(+${noiseDelta})${growthMarker}`
    )
    if (noiseDelta > 0 && logProbe.noiseTail.length > 0) {
      console.log(`NOISE-TAIL: ${logProbe.noiseTail}`)
    }
    if (fatalDelta > 0 && networkStarted) {
      console.log(`FAIL-TAIL: ${logProbe.fatalTail.join(" | ")}`)
    }

    // ── bails ──
    // Head advance, on the monitor's wall clock: a head block number unchanged
    // across the beat is re-probed once, and a head still there is a stopped
    // producer — whatever HTTP still answers, and whatever the chains' traffic
    // (their due_at is measured on the frozen head time, so no epoch bail sees
    // it). Never suppressed: a dispute pause freezes epochs, not blocks.
    if (isHeadFrozen(previousHeadBlockNumber, headBlockNumber)) {
      await sleep(HeadStallReprobeDelaySeconds * 1000)
      const reprobed = await probeChainLiveness(clioExecutable, producerUrl)
      const headBail = headStallBailReason(
        previousHeadBlockNumber,
        headBlockNumber,
        reprobed?.headBlockNumber ?? null,
        Math.round((now - previousBeatTimestamp) / 1000)
      )
      if (headBail != null) await bail(headBail, clusterPath)
    }
    previousHeadBlockNumber = headBlockNumber ?? null
    previousBeatTimestamp = now
    // Bootstrap fallback: chain answering but a chain's epoch still null/0 past
    // its deadline. Every other bail is gated on every chain at epoch >= 1 —
    // without this fallback a monitor against a dead-during-bootstrap chain
    // would print forever.
    if (firstLivenessTimestamp != null) {
      const bootstrapBail = bootstrapBailReason(
        chains,
        epochIndices,
        Math.round((now - firstLivenessTimestamp) / 1000),
        clusterConfig.identityCount,
        monitoredDuration,
        epochDurationOverrideSeconds ?? clusterConfig.defaultEpochDurationSeconds
      )
      if (bootstrapBail != null) await bail(bootstrapBail, clusterPath)
    }
    const growthBail = oppGrowthBailReason(
      networkStarted, oppDelta, opp.total, growthNowMs, firstGrowthDeadlineMs, expectEpochFreeze, overdueForBeat
    )
    if (growthBail != null) await bail(growthBail, clusterPath)
    if (networkStarted) {
      // Epoch stall, per chain: a DUE chain at the same epoch as the previous
      // beat is re-probed once its time past due_at (depot head clock) plus
      // EpochStallReprobeDelaySeconds reaches EpochStallDurations of its own
      // minimum, and bails only if STILL unchanged (a due chain that cannot
      // advance = dead cluster). An idle chain is never re-probed. Every due
      // chain shares ONE re-probe per beat. Epoch-ADVANCEMENT bails (epoch-stall
      // + opp zero-growth) — skipped when the flow intentionally holds a due
      // chain (see {@link expectEpochFreeze}).
      const overdueSeconds = chain => chainOverdueSeconds(epochStates[chain], headBlockTimeMs)
      const stallDue = expectEpochFreeze
        ? []
        : stallReprobeDueChains(chains, epochIndices, previousEpochIndices, overdueSeconds, monitoredDuration)
      if (stallDue.length > 0) {
        await sleep(EpochStallReprobeDelaySeconds * 1000)
        const reprobedStates = (await probeEpochStates(clioExecutable, producerUrl)) ?? {}
        const stalled = stalledChain(stallDue, reprobedStates, epochIndices, previousEpochIndices)
        if (stalled != null) {
          await bail(
            `${stalled} epoch stalled at ${epochIndices[stalled]} while due: ` +
              `${Math.round(overdueSeconds(stalled)) + EpochStallReprobeDelaySeconds}s past due_at ` +
              `(${EpochStallReprobeDelaySeconds}s re-probe included; epoch_duration=${monitoredDuration(stalled)}s)`,
            clusterPath
          )
        }
        stallDue.forEach(chain => {
          epochIndices[chain] = reprobedStates[chain]?.current_epoch_index ?? epochIndices[chain]
        })
      }
      // Undecided epoch, per chain: a started, unpaused chain whose current
      // epoch (genesis included) outpcons still shows undecided past its
      // allowance — traffic or not, so a dead relay group on an idle chain is
      // caught too. Skipped with --expect-epoch-freeze (see expectEpochFreeze).
      const undecidedBail = undecidedEpochBailReason(
        chains, epochStates, outpostConsensus, undecidedSince, headBlockTimeMs, monitoredDuration, expectEpochFreeze
      )
      if (undecidedBail != null) await bail(undecidedBail, clusterPath)
      // FATAL growth: bail on PERSISTENT growth only — one-off transients (nonce
      // retries, momentary table-read races) occur in PASSING runs; persistent
      // plugin breakage grows every cycle.
      if (fatalGrowthStreak >= FatalGrowthBailStreak) {
        await bail(
          `failure signatures growing across consecutive heartbeats (count=${logProbe.fatalCount}): ${logProbe.fatalTail[0] ?? ""}`,
          clusterPath
        )
      }
      if (!expectEpochFreeze && plateaued != null) {
        await bail(
          `direction ${plateaued} frozen for ${DirectionFreezeBailStreak}+ heartbeats while its chain was due and total advanced`,
          clusterPath
        )
      }
    }

    chains.forEach(chain => {
      const index = epochIndices[chain]
      if (index != null) previousEpochIndices[chain] = index
    })
    previousOppTotal = opp.total
    previousFatalCount = logProbe.fatalCount
  }

}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
