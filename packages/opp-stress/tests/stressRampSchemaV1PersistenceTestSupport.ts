import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceEndpoint,
  RunEvidencePath,
  parseRunEvidenceIteration,
  parseRunEvidenceManifest,
  parseRunEvidenceTerminal
} from "@wireio/test-opp-stress"

/** Shared deterministic ramp configuration for schema-v1 persistence scenarios. */
export const SchemaV1BaseConfig = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 30_000
} as const

/** Ethereum-to-depot endpoint used by schema-v1 persistence scenarios. */
export const SchemaV1EndpointA = RunEvidenceEndpoint.OutpostEthereumDepot

/** Depot-to-Ethereum endpoint used by schema-v1 persistence scenarios. */
export const SchemaV1EndpointB = RunEvidenceEndpoint.DepotOutpostEthereum

/** Create the deterministic controller clock used by schema-v1 persistence scenarios. */
export function controllerClock(): () => number {
  let value = 102
  return () => {
    value += 1
    return value
  }
}

/** Read the persisted iteration, terminal, and manifest records through their public parsers. */
export function readSchemaRampRecords(
  runDirectory: string,
  iterationIndex: number
) {
  const iteration = parseRunEvidenceIteration(
      readJson(
        Path.join(
          runDirectory,
          RunEvidencePath.Iterations,
          `${String(iterationIndex).padStart(6, "0")}.json`
        )
      )
    ),
    terminal = parseRunEvidenceTerminal(
      readJson(Path.join(runDirectory, RunEvidencePath.Terminal))
    ),
    manifest = parseRunEvidenceManifest(
      readJson(Path.join(runDirectory, RunEvidencePath.Manifest))
    )
  if ("error" in iteration) throw new Error("iteration must parse")
  if ("error" in terminal) throw new Error("terminal must parse")
  if ("error" in manifest) throw new Error("manifest must parse")
  return {
    iteration: iteration.value,
    terminal: terminal.value,
    manifest: manifest.value,
    legacyIterationExists: Fs.existsSync(
      Path.join(runDirectory, "iteration-0.json")
    ),
    legacyEvidenceRootIterationExists: Fs.existsSync(
      Path.join(Path.dirname(Path.dirname(runDirectory)), "iteration-0.json")
    )
  }
}

function readJson(file: string): unknown {
  return JSON.parse(Fs.readFileSync(file, "utf8"))
}
