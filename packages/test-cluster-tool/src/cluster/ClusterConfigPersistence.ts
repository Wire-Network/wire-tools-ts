import Fs from "node:fs"

import { TokenAmount } from "@wireio/opp-typescript-models"
import type { ClusterConfig } from "@wireio/debugging-shared"

/**
 * Serialise a `ClusterConfig` to JSON bytes suitable for
 * `cluster-config.json`. Plain field values pass through unchanged;
 * the `underwriterCollateral` field carries `TokenAmount` proto-message
 * instances with `bigint` amounts that `JSON.stringify` cannot serialise
 * natively, so each entry's `amount` is projected through `TokenAmount.toJson`
 * (which encodes int64 as a string). The harness-local `chain_code` field
 * (plain `number`) round-trips unchanged.
 *
 * @param config Fully-resolved cluster config.
 * @returns Pretty-printed JSON string.
 */
export function serializeClusterConfig(config: ClusterConfig): string {
  const projected = {
    ...config,
    underwriterCollateral: config.underwriterCollateral?.map(arr =>
      arr.map(entry => ({
        chain_code: entry.chain_code,
        amount: TokenAmount.toJson(entry.amount)
      }))
    )
  }
  return JSON.stringify(projected, null, 2)
}

/**
 * Parse a `cluster-config.json` payload (or raw bytes) into a fully
 * hydrated `ClusterConfig`. Rehydrates each `underwriterCollateral`
 * entry's `amount` via `TokenAmount.fromJson` so consumers see a typed
 * proto `TokenAmount` with the `bigint` amount restored, rather than the
 * JSON-encoded string that was persisted.
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
      arr.map(raw => {
        const r = raw as { chain_code: number; amount: unknown }
        return {
          chain_code: r.chain_code,
          amount: TokenAmount.fromJson(
            r.amount as Parameters<typeof TokenAmount.fromJson>[0]
          )
        }
      })
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
