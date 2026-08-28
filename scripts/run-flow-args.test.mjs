import Test from "node:test"
import Assert from "node:assert/strict"

import { forwardedFlowArguments, pnpmFlowArguments } from "./run-flow-args.mjs"

Test("no inbound delimiter forwards no flow arguments", () => {
  Assert.deepEqual(
    forwardedFlowArguments([
      "flow-emissions-soak",
      "--wire-build-path",
      "/build"
    ]),
    []
  )
  Assert.deepEqual(
    pnpmFlowArguments(["flow-emissions-soak", "--cluster-path", "/cluster"]),
    []
  )
})

Test("tokens after the delimiter are preserved exactly", () => {
  const raw = [
    "flow-emissions-soak",
    "--wire-build-path",
    "/build",
    "--",
    "--ethereum-bootstrap-json-file",
    "inputs/eth dump.json",
    "--solana-bootstrap-json-file=inputs/solana.json"
  ]
  Assert.deepEqual(forwardedFlowArguments(raw), [
    "--ethereum-bootstrap-json-file",
    "inputs/eth dump.json",
    "--solana-bootstrap-json-file=inputs/solana.json"
  ])
})

Test("pnpm receives one outbound delimiter before the exact tokens", () => {
  Assert.deepEqual(
    pnpmFlowArguments([
      "flow-emissions-soak",
      "--",
      "--ethereum-bootstrap-json-file",
      "ethereum.json"
    ]),
    ["--", "--ethereum-bootstrap-json-file", "ethereum.json"]
  )
})
