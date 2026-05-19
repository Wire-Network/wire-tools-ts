import Fs from "node:fs"

import { ChainTokenAmount } from "@wireio/opp-typescript-models"
import type { ClusterConfig } from "@wireio/debugging-shared"

/**
 * Serialise a `ClusterConfig` to JSON bytes suitable for
 * `cluster-config.json`. Plain field values pass through unchanged;
 * the `underwriterCollateral` field carries proto-message instances
 * with `bigint` amounts that `JSON.stringify` cannot serialise
 * natively, so it is projected through the message-type's
 * `.toJson()` helper (which encodes int64 as a string).
 *
 * @param config Fully-resolved cluster config.
 * @returns Pretty-printed JSON string with a trailing newline.
 */
export function serializeClusterConfig(config: ClusterConfig): string {
  const projected = {
    ...config,
    underwriterCollateral: config.underwriterCollateral?.map(arr =>
      arr.map(msg => ChainTokenAmount.toJson(msg))
    )
  }
  return JSON.stringify(projected, null, 2)
}

/**
 * Parse a `cluster-config.json` payload (or raw bytes) into a fully
 * hydrated `ClusterConfig`. Rehydrates `underwriterCollateral` via
 * `ChainTokenAmount.fromJson` so consumers see typed `ChainKind` /
 * `TokenKind` / `bigint` fields rather than the JSON-encoded strings
 * that were persisted.
 *
 * Accepts either the raw file contents (as a `string`) or an already-
 * parsed JSON value (`unknown`). The dual signature lets the same
 * helper serve both file-reads and in-memory IPC paths.
 *
 * @param input Raw JSON string OR an already-parsed JSON object.
 * @returns Hydrated cluster config.
 */
export function deserializeClusterConfig(input: string | unknown): ClusterConfig {
  const parsed: ClusterConfig =
    typeof input === "string" ? JSON.parse(input) : (input as ClusterConfig)
  if (parsed.underwriterCollateral) {
    parsed.underwriterCollateral = parsed.underwriterCollateral.map(arr =>
      arr.map(raw =>
        ChainTokenAmount.fromJson(
          raw as Parameters<typeof ChainTokenAmount.fromJson>[0]
        )
      )
    )
  }
  return parsed
}

/**
 * Convenience wrapper: read the file at `filePath` and parse it via
 * {@link deserializeClusterConfig}.
 */
export function readClusterConfigFile(filePath: string): ClusterConfig {
  return deserializeClusterConfig(Fs.readFileSync(filePath, "utf-8"))
}

/**
 * Convenience wrapper: serialise `config` and write it to `filePath`.
 */
export function writeClusterConfigFile(
  filePath: string,
  config: ClusterConfig
): void {
  Fs.writeFileSync(filePath, serializeClusterConfig(config))
}
