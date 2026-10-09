import Os from "node:os"

import { ProcessSignalName, ProcessSignals } from "@wireio/cluster-tool-shared"

describe("ProcessSignals", () => {
  it("is an identity enum whose names are the POSIX spellings Node accepts", () => {
    Object.entries(ProcessSignalName).forEach(([key, value]) => expect(value).toBe(key))
    expect(Object.keys(ProcessSignalName)).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]))
  })

  it("maps every signal name to its POSIX number, matching the platform table", () => {
    expect(Object.keys(ProcessSignals).sort()).toEqual(Object.values(ProcessSignalName).sort())
    expect(ProcessSignals[ProcessSignalName.SIGINT]).toBe(2)
    expect(ProcessSignals[ProcessSignalName.SIGKILL]).toBe(9)
    expect(ProcessSignals[ProcessSignalName.SIGTERM]).toBe(15)
    // The portable signals agree with the host table (SIGUSR*/SIGCHLD/… differ across platforms).
    ;[ProcessSignalName.SIGHUP, ProcessSignalName.SIGINT, ProcessSignalName.SIGKILL, ProcessSignalName.SIGTERM].forEach(signal =>
      expect(ProcessSignals[signal]).toBe(Os.constants.signals[signal])
    )
  })

  it("has no number for a name outside the set", () => {
    expect((ProcessSignals as Record<string, number>).SIGBOGUS).toBeUndefined()
  })
})
