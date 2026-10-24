import Assert from "node:assert"
import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"

import { match } from "ts-pattern"

import {
  BindConfigPortProtocol,
  type BindConfigPortRange
} from "@wireio/cluster-tool-shared"
import { NestedError } from "@wireio/shared"

import { MaximumPort, MinimumPort } from "./netUtils.js"

/** Linux shares this automatic port range across TCP/UDP and IPv4/IPv6. */
const LinuxAutomaticPortRangeFile = "/proc/sys/net/ipv4/ip_local_port_range"
/** Bound read-only host configuration queries so allocation cannot hang. */
const PortRangeQueryTimeoutMs = 5_000
/** Darwin exposes ordinary, high and privileged automatic ranges. */
const DarwinAutomaticPortRangeKeys = [
  ["first", "last"],
  ["hifirst", "hilast"],
  ["lowfirst", "lowlast"]
] as const
/** Windows maintains a separate automatic range per family and transport. */
const WindowsAddressFamilies = ["ipv4", "ipv6"] as const

function parseAutomaticPortRange(
  text: string,
  source: string,
  descending = false
): BindConfigPortRange {
  Assert.match(
    text.trim(),
    /^\d+\s+\d+$/,
    `invalid automatic port range from ${source}: ${text}`
  )
  const [start, end] = text.trim().split(/\s+/).map(Number),
    first = descending ? Math.min(start, end) : start,
    last = descending ? Math.max(start, end) : end
  Assert.ok(
    Number.isSafeInteger(first) &&
      Number.isSafeInteger(last) &&
      first >= MinimumPort &&
      last <= MaximumPort &&
      first <= last,
    `invalid automatic port range from ${source}: ${text}`
  )
  return { first, last }
}

/**
 * Read the host's actual automatic client-port ranges without modifying them.
 * Allocation fails if configuration is unreadable or unsupported: assuming OS
 * defaults would reintroduce the bind race on hosts with customized settings.
 * Observe once per allocation transaction; administrators must keep these
 * settings stable for the lifetime of the resulting cluster.
 *
 * @returns Inclusive ranges to exclude from automatic service allocation.
 * @throws If the host range cannot be determined reliably.
 */
export function readAutomaticPortRanges(): BindConfigPortRange[] {
  const platform = Os.platform()
  try {
    return match(platform)
      .with("linux", readAutomaticPortRangesLinux)
      .with("darwin", readAutomaticPortRangesDarwin)
      .with("win32", readAutomaticPortRangesWindows)
      .otherwise(() => {
        throw new Error(
          `unsupported automatic port range platform: ${platform}`
        )
      })
  } catch (cause) {
    throw new NestedError("cannot determine host automatic port ranges", {
      cause,
      context: { platform }
    })
  }
}

function readAutomaticPortRangesLinux(): BindConfigPortRange[] {
  return [
    parseAutomaticPortRange(
      Fs.readFileSync(LinuxAutomaticPortRangeFile, "utf8"),
      LinuxAutomaticPortRangeFile
    )
  ]
}

function readAutomaticPortRangesDarwin(): BindConfigPortRange[] {
  const values = execFileSync(
    "/usr/sbin/sysctl",
    [
      "-n",
      ...DarwinAutomaticPortRangeKeys.flatMap(keys =>
        keys.map(key => `net.inet.ip.portrange.${key}`)
      )
    ],
    { encoding: "utf8", timeout: PortRangeQueryTimeoutMs }
  )
    .trim()
    .split(/\s+/)
  Assert.equal(
    values.length,
    DarwinAutomaticPortRangeKeys.flat().length,
    "incomplete Darwin automatic port ranges"
  )
  return DarwinAutomaticPortRangeKeys.map((keys, index) =>
    parseAutomaticPortRange(
      values.slice(index * keys.length, (index + 1) * keys.length).join(" "),
      "sysctl net.inet.ip.portrange",
      true
    )
  )
}

function readAutomaticPortRangesWindows(): BindConfigPortRange[] {
  return WindowsAddressFamilies.flatMap(family =>
    [BindConfigPortProtocol.tcp, BindConfigPortProtocol.udp].map(protocol => {
      const text = execFileSync(
          "netsh",
          ["interface", family, "show", "dynamicportrange", protocol],
          { encoding: "utf8", timeout: PortRangeQueryTimeoutMs }
        ),
        // Numeric values after ':' survive localized netsh field labels.
        values = [...text.matchAll(/:\s*(\d+)\s*$/gm)].map(value =>
          Number(value[1])
        )
      Assert.equal(
        values.length,
        2,
        `incomplete Windows automatic port range for ${family}/${protocol}`
      )
      const [first, count] = values
      Assert.ok(
        count > 0,
        `empty Windows automatic port range for ${family}/${protocol}`
      )
      return parseAutomaticPortRange(
        `${first} ${first + count - 1}`,
        `netsh ${family}/${protocol}`
      )
    })
  )
}
