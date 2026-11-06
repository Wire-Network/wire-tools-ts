import type { WireLcoImportTool } from "../../tools/wire/WireLcoImportTool.js"
import { outputKey } from "../OutputStore.js"

/**
 * The launch-data (LCO) import's plan, published by `LcoImportSteps.runPublishPlan` and read
 * by every import, record and verify Step after it.
 */
export const LcoImportPlanKey = outputKey<WireLcoImportTool.Plan>(
  "lco-import-plan",
  "each outpost chain's syndicated positions, WIRE claims and LCO yield pool"
)
