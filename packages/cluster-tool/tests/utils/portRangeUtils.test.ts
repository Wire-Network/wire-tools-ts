import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"

import { BindConfigPortProtocol } from "@wireio/cluster-tool-shared"
import { readAutomaticPortRanges } from "@wireio/cluster-tool/utils"

jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>(
    "node:child_process"
  ),
  execFileSync: jest.fn()
}))

describe("readAutomaticPortRanges", () => {
  afterEach(() => jest.restoreAllMocks())

  it("reads the actual Linux range on each observation", () => {
    jest.spyOn(Os, "platform").mockReturnValue("linux")
    const read = jest
      .spyOn(Fs, "readFileSync")
      .mockReturnValueOnce("20000\t40000\n")
      .mockReturnValueOnce("30000 50000\n")
    expect(readAutomaticPortRanges()).toEqual([{ first: 20_000, last: 40_000 }])
    expect(readAutomaticPortRanges()).toEqual([{ first: 30_000, last: 50_000 }])
    expect(read).toHaveBeenCalledWith(
      "/proc/sys/net/ipv4/ip_local_port_range",
      "utf8"
    )
  })

  it.each([
    "",
    "32768",
    "32768 60999 extra",
    "60000 30000",
    "0 65535",
    "1024 65536",
    "1.5 40000"
  ])("rejects malformed Linux settings: %s", text => {
    jest.spyOn(Os, "platform").mockReturnValue("linux")
    jest.spyOn(Fs, "readFileSync").mockReturnValue(text)
    expect(readAutomaticPortRanges).toThrow(
      /cannot determine host automatic port ranges/
    )
  })

  it("preserves the cause when host settings cannot be read", () => {
    const cause = new Error("permission denied")
    jest.spyOn(Os, "platform").mockReturnValue("linux")
    jest.spyOn(Fs, "readFileSync").mockImplementation(() => {
      throw cause
    })
    expect(readAutomaticPortRanges).toThrow(expect.objectContaining({ cause }))
  })

  it("reads all Darwin automatic ranges and normalizes descending privileged bounds", () => {
    jest.spyOn(Os, "platform").mockReturnValue("darwin")
    jest
      .mocked(execFileSync)
      .mockReturnValue("49152\n65535\n40000\n65000\n1023\n600\n")
    expect(readAutomaticPortRanges()).toEqual([
      { first: 49_152, last: 65_535 },
      { first: 40_000, last: 65_000 },
      { first: 600, last: 1023 }
    ])
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/sbin/sysctl",
      expect.arrayContaining([
        "-n",
        "net.inet.ip.portrange.hifirst",
        "net.inet.ip.portrange.lowlast"
      ]),
      expect.objectContaining({ timeout: 5_000 })
    )
  })

  it("fails on an incomplete Darwin observation", () => {
    jest.spyOn(Os, "platform").mockReturnValue("darwin")
    jest.mocked(execFileSync).mockReturnValue("49152\n65535\n")
    expect(readAutomaticPortRanges).toThrow(
      /cannot determine host automatic port ranges/
    )
  })

  it("reads both Windows families and transports without relying on English labels", () => {
    jest.spyOn(Os, "platform").mockReturnValue("win32")
    jest
      .mocked(execFileSync)
      .mockReset()
      .mockReturnValueOnce("TCP IPv4\nDébut : 40000\nNombre : 1000\n")
      .mockReturnValueOnce("UDP IPv4\nStart : 41000\nCount : 500\n")
      .mockReturnValueOnce("TCP IPv6\nStart : 42000\nCount : 1000\n")
      .mockReturnValueOnce("UDP IPv6\nStart : 43000\nCount : 500\n")
    expect(readAutomaticPortRanges()).toEqual([
      { first: 40_000, last: 40_999 },
      { first: 41_000, last: 41_499 },
      { first: 42_000, last: 42_999 },
      { first: 43_000, last: 43_499 }
    ])
    expect(execFileSync).toHaveBeenCalledTimes(4)
    ;["ipv4", "ipv6"].forEach(family =>
      [BindConfigPortProtocol.tcp, BindConfigPortProtocol.udp].forEach(
        protocol =>
          expect(execFileSync).toHaveBeenCalledWith(
            "netsh",
            ["interface", family, "show", "dynamicportrange", protocol],
            expect.objectContaining({ timeout: 5_000 })
          )
      )
    )
  })

  it.each([
    "Start : 40000\n",
    "Start : 65000\nCount : 1000\n",
    "Start : 40000\nCount : 0\n"
  ])("fails on invalid Windows observations: %s", text => {
    jest.spyOn(Os, "platform").mockReturnValue("win32")
    jest.mocked(execFileSync).mockReturnValue(text)
    expect(readAutomaticPortRanges).toThrow(
      /cannot determine host automatic port ranges/
    )
  })

  it("fails on unsupported platforms instead of assuming a default range", () => {
    jest.spyOn(Os, "platform").mockReturnValue("aix")
    expect(readAutomaticPortRanges).toThrow(
      /cannot determine host automatic port ranges/
    )
  })
})
