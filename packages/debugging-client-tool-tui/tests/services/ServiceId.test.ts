import { ServiceId } from "@wireio/debugging-client-tool-tui/services/ServiceId.js"

describe("ServiceId", () => {
  it("exposes stable string-valued identifiers for every service class", () => {
    expect(ServiceId.Redux).toBe("redux")
    expect(ServiceId.OPPTracking).toBe("opp-tracking")
    expect(ServiceId.ProcessMonitor).toBe("process-monitor")
    expect(ServiceId.LogTailing).toBe("log-tailing")
  })

  it("enum membership is a single source of truth — guards against drift", () => {
    expect(Object.keys(ServiceId)).toHaveLength(4)
  })
})
