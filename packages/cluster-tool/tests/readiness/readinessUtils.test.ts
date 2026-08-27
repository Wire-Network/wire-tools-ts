import { readinessEndpointLabel } from "@wireio/cluster-tool/readiness"

describe("readinessEndpointLabel", () => {
  it("retains routing information while removing secrets", () => {
    expect(
      readinessEndpointLabel(
        "https://operator:secret@wire.example/v1/health?token=hidden#fragment"
      )
    ).toBe("https://wire.example/v1/health")
  })
})
