import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import {
  ProcessManager,
  SolanaValidatorProcess
} from "@wireio/cluster-tool/cluster/processes"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

describe("Steps.processes.solanaValidator", () => {
  /**
   * One cluster root for the whole file — `ProcessManager.setClusterPath` may
   * be set ONCE per process, so every context here names the SAME root.
   */
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-validator-steps-"))
    ProcessManager.setClusterPath(dir)
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A wire-solana root carrying ONLY the committed program keypair — no `.so`,
   * no build manifest. That is exactly the shape a cloned/never-built tree has,
   * and the keypair is present because it is committed to the repo.
   */
  function newUnbuiltSolanaPath(prefix: string): string {
    const solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix)),
      keypairFile = SolanaOutpostProgramTool.programKeypairFile(solanaPath)
    Fs.mkdirSync(Path.dirname(keypairFile), { recursive: true })
    Fs.writeFileSync(
      keypairFile,
      JSON.stringify([...Keypair.generate().secretKey])
    )
    return solanaPath
  }

  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.solanaValidator.planStart(
      Report.Actor.SolanaOutpost,
      "start-validator",
      "start solana-test-validator + liqsol_core (OPP outpost)",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  describe("resolvePrograms", () => {
    it("resolves the .so PATH without requiring a built wire-solana tree", () => {
      // The `start.sh` renderer resolves this for a tree it will never launch
      // itself — `create-external-config` clones a cluster whose wire-solana
      // was never built here. Demanding a verified binary would fail that
      // pipeline on a payload destined for another host entirely.
      const solanaPath = newUnbuiltSolanaPath("solana-unbuilt-")
      try {
        const config = fixtureContext({
            clusterPath: dir,
            dataPath: Path.join(dir, "data"),
            solanaPath
          }).config,
          [program] = Steps.processes.solanaValidator.resolvePrograms(config)
        expect(program.name).toBe(SolanaOutpostProgramTool.ProgramName)
        expect(program.soFile).toBe(
          SolanaOutpostProgramTool.programSoFile(solanaPath)
        )
        expect(Fs.existsSync(program.soFile)).toBe(false)
      } finally {
        Fs.rmSync(solanaPath, { recursive: true, force: true })
      }
    })
  })

  describe("runStart", () => {
    it("REJECTS an unverified binary before launching the validator", async () => {
      // runStart IS the deploy — it loads the .so at genesis, so the recorded
      // build has to match here even though the renderer above tolerates its
      // absence.
      const solanaPath = newUnbuiltSolanaPath("solana-unbuilt-start-")
      try {
        const ctx = fixtureContext({
          clusterPath: dir,
          dataPath: Path.join(dir, "data"),
          solanaPath
        })
        await expect(
          Steps.processes.solanaValidator.runStart(
            ctx,
            null,
            new AbortController().signal
          )
        ).rejects.toThrow(/liqsol_core \.so missing.*build:programs/s)
        expect(
          ctx.processManager.get(SolanaValidatorProcess.ProcessLabel)
        ).toBeNull()
      } finally {
        Fs.rmSync(solanaPath, { recursive: true, force: true })
      }
    })
  })
})
