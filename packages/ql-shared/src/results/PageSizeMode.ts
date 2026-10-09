/** How rows are requested from the server. */
export enum PageSizeMode {
  /** One server window per page (`limit` + `offset`). */
  paged = "paged",
  /** ONE request without `limit` — one snapshot, capped by query-max-result-rows. */
  all = "all"
}
