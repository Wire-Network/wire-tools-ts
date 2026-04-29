import { generateGenesis } from "@wireio/test-cluster-tool/cluster/genesis"
import {
  DEV_K1_PUBLIC_KEY,
  MAX_BLOCK_CPU_USAGE,
  MAX_TRANSACTION_CPU_USAGE
} from "@wireio/test-cluster-tool/cluster/constants"

describe("generateGenesis", () => {
  it("returns an object with initial_timestamp, initial_key, and initial_configuration", () => {
    const genesis = generateGenesis()
    expect(genesis).toHaveProperty("initial_timestamp")
    expect(genesis).toHaveProperty("initial_key")
    expect(genesis).toHaveProperty("initial_configuration")
  })

  it("uses DEV_K1_PUBLIC_KEY as the default initial_key", () => {
    const genesis = generateGenesis()
    expect(genesis.initial_key).toBe(DEV_K1_PUBLIC_KEY)
  })

  it("produces a valid ISO-like timestamp (without trailing Z)", () => {
    const genesis = generateGenesis()
    // The code strips the trailing "Z" from toISOString()
    expect(genesis.initial_timestamp).not.toMatch(/Z$/)
    // Re-adding Z should parse to a valid date
    const parsed = new Date(genesis.initial_timestamp + "Z")
    expect(parsed.getTime()).not.toBeNaN()
  })

  it("includes all required initial_configuration fields", () => {
    const genesis = generateGenesis()
    const cfg = genesis.initial_configuration

    const requiredFields = [
      "max_block_net_usage",
      "target_block_net_usage_pct",
      "max_transaction_net_usage",
      "base_per_transaction_net_usage",
      "net_usage_leeway",
      "context_free_discount_net_usage_num",
      "context_free_discount_net_usage_den",
      "max_block_cpu_usage",
      "target_block_cpu_usage_pct",
      "max_transaction_cpu_usage",
      "min_transaction_cpu_usage",
      "max_transaction_lifetime",
      "deferred_trx_expiration_window",
      "max_transaction_delay",
      "max_inline_action_size",
      "max_inline_action_depth",
      "max_authority_depth"
    ] as const

    for (const field of requiredFields) {
      expect(cfg).toHaveProperty(field)
      expect(typeof cfg[field]).toBe("number")
    }
  })

  it("uses cluster_manager CPU overrides by default (400k / 375k)", () => {
    const genesis = generateGenesis()
    expect(genesis.initial_configuration.max_block_cpu_usage).toBe(
      MAX_BLOCK_CPU_USAGE
    )
    expect(genesis.initial_configuration.max_transaction_cpu_usage).toBe(
      MAX_TRANSACTION_CPU_USAGE
    )
  })

  it("allows overriding the initial key", () => {
    const customKey = "SYS_CUSTOM_KEY_FOR_TESTING"
    const genesis = generateGenesis({ initialKey: customKey })
    expect(genesis.initial_key).toBe(customKey)
  })

  it("allows overriding CPU limits", () => {
    const genesis = generateGenesis({
      maxBlockCpuUsage: 999999,
      maxTransactionCpuUsage: 888888
    })
    expect(genesis.initial_configuration.max_block_cpu_usage).toBe(999999)
    expect(genesis.initial_configuration.max_transaction_cpu_usage).toBe(888888)
  })

  it("includes initial_finalizer_key when provided", () => {
    const genesis = generateGenesis({ initialFinalizerKey: "BLS_PUB_KEY_123" })
    expect(genesis.initial_finalizer_key).toBe("BLS_PUB_KEY_123")
  })

  it("omits initial_finalizer_key when not provided", () => {
    const genesis = generateGenesis()
    expect(genesis).not.toHaveProperty("initial_finalizer_key")
  })
})
