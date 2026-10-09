/** How one execution ended (recorded in history). */
export enum QueryOutcome {
  success = "success",
  engineError = "engineError",
  transportError = "transportError",
  cancelled = "cancelled"
}
