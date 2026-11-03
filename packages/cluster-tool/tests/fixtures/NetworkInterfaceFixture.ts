import type Os from "node:os"

/**
 * A synthetic host for address-classification tests. Documentation-prefix
 * addresses stay local or remote by construction, independent of the runner.
 * These interfaces are only returned by a mock; no address is bound or dialed.
 */
export namespace NetworkInterfaceFixture {
  export const InterfaceName = "eth0"
  export const LocalAddressV4 = "192.0.2.10"
  export const LocalAddressV6 = "2001:db8::10"
  export const RemoteAddressV4 = "192.0.2.1"
  export const OtherRemoteAddressV4 = "192.0.2.2"
  export const RemoteAddressV6 = "2001:db8::1"

  export const Interfaces: ReturnType<typeof Os.networkInterfaces> = {
    [InterfaceName]: [
      {
        address: LocalAddressV4,
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${LocalAddressV4}/24`
      },
      {
        address: LocalAddressV6,
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${LocalAddressV6}/64`,
        scopeid: 0
      }
    ]
  }
}
