/**
 * YYYYMMDD date stamp — matches harness `ProcessManager.currentDateStamp` so
 * client-side log-path construction resolves the same files the server writes.
 */
export function currentDateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}
