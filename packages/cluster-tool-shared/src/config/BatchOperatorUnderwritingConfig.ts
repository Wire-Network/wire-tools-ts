import { z } from "zod"

import { TokenAmountCodec } from "../types/ChainTokenAmount.js"

/**
 * How a cluster's batch operators run the `batch_operator_plugin` underwriter role — every
 * operator runs it, bonding from its own account. Persisted in `cluster-config.json`;
 * the member is `null` when the role is off.
 */
export const BatchOperatorUnderwritingConfigSchema = z.object({
  /**
   * How many bootstrap batch operators, in label order from `batchop.a`, the epoch-zero mock
   * import funds with both LIQSOL and LIQETH. The rest run the role holding nothing, so they never bond. Changing it
   * changes which operators can underwrite.
   */
  fundedOperatorCount: z.number().int().nonnegative(),
  /**
   * The `--batch-underwriter-max-exposure` caps every underwriting operator runs with, one
   * per shadow token: the most it may have bonded and unclaimed at once. A token without one
   * is not underwritten. At least one: an operator with no cap underwrites nothing.
   */
  maxExposure: z.array(TokenAmountCodec).min(1)
})

/** The schema-inferred underwriting configuration of {@link BatchOperatorUnderwritingConfigSchema}. */
export type BatchOperatorUnderwritingConfig = z.infer<
  typeof BatchOperatorUnderwritingConfigSchema
>

/**
 * Caller options: every member optional; `ClusterConfigProvider.resolveBatchOperatorUnderwriting`
 * defaults `fundedOperatorCount` to every bootstrap batch operator and `maxExposure` to
 * `10.000000000 LIQSOL` and `10.000000000 LIQETH`.
 */
export type BatchOperatorUnderwritingOptions =
  Partial<BatchOperatorUnderwritingConfig>
