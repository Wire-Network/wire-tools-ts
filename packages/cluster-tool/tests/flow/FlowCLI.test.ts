import { normalizeFlowCLIArguments } from "@wireio/cluster-tool/flow"

describe("normalizeFlowCLIArguments", () => {
  it("removes the one pnpm delimiter before forwarded flow flags", () => {
    expect(
      normalizeFlowCLIArguments([
        "--",
        "--ethereum-bootstrap-json-file",
        "/inputs/ethereum.json"
      ])
    ).toEqual([
      "--ethereum-bootstrap-json-file",
      "/inputs/ethereum.json"
    ])
  })

  it("preserves direct flow arguments when no delimiter is present", () => {
    expect(
      normalizeFlowCLIArguments([
        "--solana-bootstrap-json-file",
        "/inputs/solana.json"
      ])
    ).toEqual([
      "--solana-bootstrap-json-file",
      "/inputs/solana.json"
    ])
  })
})
