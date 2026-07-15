import { Constants } from "../../Constants.js"
import type { Renderer } from "../../utils/Renderer.js"
import type { ClusterConfig } from "../ClusterConfig.js"

/**
 * Renders `genesis.json` (ports the former `cluster/genesis.ts`). Uses the dev
 * K1 public key as `initial_key`, the cluster's optional finalizer key, and the
 * cluster_manager CPU overrides in `initial_configuration`. `new Date()` is the
 * real harness path (genesis timestamp).
 */
export class ClusterConfigGenesisRenderer implements Renderer {
  constructor(private readonly config: ClusterConfig) {}

  render(): string {
    return JSON.stringify(
      {
        initial_timestamp: new Date().toISOString().replace("Z", ""),
        initial_key: Constants.DEV_K1_PUBLIC_KEY,
        ...(this.config.initialFinalizerKey
          ? { initial_finalizer_key: this.config.initialFinalizerKey }
          : {}),
        initial_configuration: {
          max_block_net_usage: 1_048_576,
          target_block_net_usage_pct: 10_000,
          max_transaction_net_usage: 524_288,
          net_usage_leeway: 500,
          context_free_discount_net_usage_num: 20,
          context_free_discount_net_usage_den: 100,
          max_block_cpu_usage: Constants.MAX_BLOCK_CPU_USAGE,
          target_block_cpu_usage_pct: 10,
          max_transaction_cpu_usage: Constants.MAX_TRANSACTION_CPU_USAGE,
          min_transaction_cpu_usage: 100,
          max_transaction_lifetime: 3_600,
          deferred_trx_expiration_window: 600,
          max_transaction_delay: 3_888_000,
          max_inline_action_size: 524_287,
          max_inline_action_depth: 10,
          max_authority_depth: 10
        }
      },
      null,
      2
    )
  }
}
