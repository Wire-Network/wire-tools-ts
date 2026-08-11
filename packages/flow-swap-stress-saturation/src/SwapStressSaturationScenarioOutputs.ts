import { outputKey } from "@wireio/cluster-tool"
import type { StressRampResult } from "./swap-stress/index.js"

/**
 * Typed cross-step outputs for the swap-stress saturation scenario — the ramp
 * campaign's result rides `ctx.outputs` under these keys (never a shared
 * mutable closure). The RunCampaign step writes; the saturation verification
 * reads back.
 */
export namespace SwapStressSaturationScenarioOutputs {
  /** Final saturation-ramp result the VerifySaturation step asserts against. */
  export const stressRampResult = outputKey<StressRampResult>(
    "stressSaturation.rampResult",
    "final saturation-ramp result (status, endpoints, iteration evidence)"
  )
}
