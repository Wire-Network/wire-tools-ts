import {
  BindRegistrationSchemaCodec,
  MaximumPort,
  MinimumPort,
  type BindRegistration
} from "@wireio/cluster-tool-shared"

/** A registration as a Python client writes it (ports already issued, replayed here). */
const PythonRegistration: BindRegistration = {
  executable: "python3",
  ports: [12_100, 12_101, 12_102]
}

describe("BindRegistrationSchemaCodec", () => {
  it("round-trips a registration", () => {
    expect(
      BindRegistrationSchemaCodec.deserialize(
        BindRegistrationSchemaCodec.serialize(PythonRegistration)
      )
    ).toEqual(PythonRegistration)
  })

  it("accepts the port range's bounds", () => {
    expect(
      BindRegistrationSchemaCodec.check({
        executable: PythonRegistration.executable,
        ports: [MinimumPort, MaximumPort]
      })
    ).toBe(true)
  })

  it("accepts an empty executable (an owner without procfs) and no ports", () => {
    expect(BindRegistrationSchemaCodec.check({ executable: "", ports: [] })).toBe(true)
  })

  it("ignores members it does not define", () => {
    expect(
      BindRegistrationSchemaCodec.deserialize(
        JSON.stringify({ ...PythonRegistration, owner: "wire-sysio" })
      )
    ).toEqual(PythonRegistration)
  })

  it.each([
    ["no executable", { ports: PythonRegistration.ports }],
    ["no ports", { executable: PythonRegistration.executable }],
    ["a fractional port", { ...PythonRegistration, ports: [12_100.5] }],
    ["a string port", { ...PythonRegistration, ports: ["12100"] }],
    ["a non-string executable", { ...PythonRegistration, executable: 3 }],
    ["port 0", { ...PythonRegistration, ports: [MinimumPort - 1] }],
    ["a port above the range", { ...PythonRegistration, ports: [MaximumPort + 1] }],
    ["a repeated port", { ...PythonRegistration, ports: [12_100, 12_100] }]
  ])("rejects a registration with %s", (_label, value) => {
    expect(BindRegistrationSchemaCodec.check(value)).toBe(false)
  })

  it("rejects text that is not JSON", () => {
    expect(() => BindRegistrationSchemaCodec.deserialize("not json {")).toThrow(
      /invalid JSON/
    )
  })
})
