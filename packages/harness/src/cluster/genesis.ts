/**
 * Genesis JSON generation matching the Python launcher's `init_genesis()`.
 *
 * See: wire-sysio/tests/TestHarness/launcher.py  (class cluster_generator)
 */

import {
  DEV_K1_PUBLIC_KEY,
  MAX_BLOCK_CPU_USAGE,
  MAX_TRANSACTION_CPU_USAGE
} from "./constants.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitialConfiguration {
  max_block_net_usage: number
  target_block_net_usage_pct: number
  max_transaction_net_usage: number
  base_per_transaction_net_usage: number
  net_usage_leeway: number
  context_free_discount_net_usage_num: number
  context_free_discount_net_usage_den: number
  max_block_cpu_usage: number
  target_block_cpu_usage_pct: number
  max_transaction_cpu_usage: number
  min_transaction_cpu_usage: number
  max_transaction_lifetime: number
  deferred_trx_expiration_window: number
  max_transaction_delay: number
  max_inline_action_size: number
  max_inline_action_depth: number
  max_authority_depth: number
}

export interface GenesisJson {
  initial_timestamp: string
  initial_key: string
  initial_finalizer_key?: string
  initial_configuration: InitialConfiguration
}

export interface GenerateGenesisOptions {
  /** Override the initial public key (defaults to DEV_K1_PUBLIC_KEY). */
  initialKey?: string
  /** Override the initial BLS finalizer public key. */
  initialFinalizerKey?: string
  /** Override max_block_cpu_usage (defaults to cluster_manager's 400000). */
  maxBlockCpuUsage?: number
  /** Override max_transaction_cpu_usage (defaults to cluster_manager's 375000). */
  maxTransactionCpuUsage?: number
}

// ---------------------------------------------------------------------------
// Default initial_configuration (matches launcher.py exactly)
// ---------------------------------------------------------------------------

/**
 * Returns the default initial_configuration values from the Python launcher.
 *
 * The launcher uses 200000 / 150000 as its built-in defaults for CPU limits,
 * but cluster_manager.py always overrides them to 400000 / 375000.  This
 * function accepts optional overrides for both values.
 */
function defaultInitialConfiguration(
  maxBlockCpu: number,
  maxTxCpu: number
): InitialConfiguration {
  return {
    max_block_net_usage: 1_048_576,
    target_block_net_usage_pct: 10_000,
    max_transaction_net_usage: 524_288,
    base_per_transaction_net_usage: 12,
    net_usage_leeway: 500,
    context_free_discount_net_usage_num: 20,
    context_free_discount_net_usage_den: 100,
    max_block_cpu_usage: maxBlockCpu,
    target_block_cpu_usage_pct: 10,
    max_transaction_cpu_usage: maxTxCpu,
    min_transaction_cpu_usage: 100,
    max_transaction_lifetime: 3_600,
    deferred_trx_expiration_window: 600,
    max_transaction_delay: 3_888_000,
    max_inline_action_size: 524_287,
    max_inline_action_depth: 10,
    max_authority_depth: 10
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a genesis.json object matching the Python launcher output.
 *
 * When called without arguments the result uses:
 *  - `initial_timestamp`  = current UTC ISO-8601 string
 *  - `initial_key`        = DEV_K1_PUBLIC_KEY
 *  - `initial_configuration` with cluster_manager overrides (400k / 375k CPU)
 */
export function generateGenesis(opts?: GenerateGenesisOptions): GenesisJson {
  const now = new Date()
  const initialTimestamp = now.toISOString().replace("Z", "")

  const maxBlockCpu = opts?.maxBlockCpuUsage ?? MAX_BLOCK_CPU_USAGE
  const maxTxCpu = opts?.maxTransactionCpuUsage ?? MAX_TRANSACTION_CPU_USAGE

  const genesis: GenesisJson = {
    initial_timestamp: initialTimestamp,
    initial_key: opts?.initialKey ?? DEV_K1_PUBLIC_KEY,
    initial_configuration: defaultInitialConfiguration(maxBlockCpu, maxTxCpu)
  }

  if (opts?.initialFinalizerKey) {
    genesis.initial_finalizer_key = opts.initialFinalizerKey
  }

  return genesis
}
