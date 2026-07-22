import * as Fs from "node:fs"
import * as Path from "node:path"

import { parseJsonLogLine, PidSources } from "@wireio/debugging-shared"
import { ClusterManager } from "@wireio/test-cluster-tool"

import type { SwapStressPhaseRunnerDeps } from "@wireio/test-flow-swap-stress-saturation"

/** JSONL log filename prefix emitted by nodeop's daily file appender. */
const DailyLogPrefix = "logs_"

/** Failure fragments emitted by batch_operator_plugin and outpost_opp_job. */
const BatchOperatorFailurePatterns = [
  /outbound delivery failed/,
  /batch_operator: push .* failed/
]

/** Create a phase-runner probe that extracts concrete batch-operator failures from cluster logs. */
export function batchOperatorFailureProbe(
  clusterPath: string
): NonNullable<SwapStressPhaseRunnerDeps["batchOperatorFailureProbe"]> {
  return async request =>
    findBatchOperatorFailure(
      clusterPath,
      request.startedAtMs,
      request.endedAtMs
    )
}

/** Find the first batch-operator failure logged inside a phase window. */
export function findBatchOperatorFailure(
  clusterPath: string,
  startedAtMs: number,
  endedAtMs: number
): string | null {
  return (
    batchOperatorLogFiles(clusterPath)
      .map(filePath =>
        findBatchOperatorFailureInFile(filePath, startedAtMs, endedAtMs)
      )
      .find((failure): failure is string => failure !== null) ?? null
  )
}

function batchOperatorLogFiles(clusterPath: string): readonly string[] {
  const dataPath = Path.join(clusterPath, "data")
  if (!Fs.existsSync(dataPath)) return []
  return Fs.readdirSync(dataPath, { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() &&
        entry.name.startsWith(ClusterManager.BatchOpNodePrefix)
    )
    .flatMap(entry =>
      dailyLogFiles(Path.join(dataPath, entry.name, PidSources.LogsSubdir))
    )
    .sort()
}

function dailyLogFiles(logsPath: string): readonly string[] {
  if (!Fs.existsSync(logsPath)) return []
  return Fs.readdirSync(logsPath, { withFileTypes: true })
    .filter(
      entry =>
        entry.isFile() &&
        entry.name.startsWith(DailyLogPrefix) &&
        entry.name.endsWith(PidSources.JsonlExt)
    )
    .map(entry => Path.join(logsPath, entry.name))
}

function findBatchOperatorFailureInFile(
  filePath: string,
  startedAtMs: number,
  endedAtMs: number
): string | null {
  return (
    Fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .map(line => parseLogLine(line))
      .find(
        record =>
          record !== null &&
          isInWindow(record.ts, startedAtMs, endedAtMs) &&
          isBatchOperatorFailure(record.msg)
      )?.msg ?? null
  )
}

function parseLogLine(line: string): BatchOperatorLogRecord | null {
  const parsed = parseJsonLogLine(line)
  return isBatchOperatorLogRecord(parsed) ? parsed : null
}

function isBatchOperatorLogRecord(
  value: unknown
): value is BatchOperatorLogRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "ts" in value &&
    "msg" in value &&
    typeof value.ts === "string" &&
    typeof value.msg === "string"
  )
}

function isInWindow(
  timestamp: string,
  startedAtMs: number,
  endedAtMs: number
): boolean {
  const timestampMs = Date.parse(timestamp)
  return (
    Number.isFinite(timestampMs) &&
    timestampMs >= startedAtMs &&
    timestampMs <= endedAtMs
  )
}

function isBatchOperatorFailure(message: string): boolean {
  return BatchOperatorFailurePatterns.some(pattern => pattern.test(message))
}

type BatchOperatorLogRecord = {
  readonly ts: string
  readonly msg: string
}
