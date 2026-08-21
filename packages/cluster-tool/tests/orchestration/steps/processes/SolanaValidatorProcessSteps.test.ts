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
import {
  SolanaFundingTool,
  SolanaOutpostProgramTool
} from "@wireio/cluster-tool/tools/solana"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"
import { fixtureConfig } from "../../../config/clusterConfigFixture.js"

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
    const solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix))
    SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program => {
      const keypairFile = SolanaOutpostProgramTool.programKeypairFile(
        solanaPath,
        program
      )
      Fs.mkdirSync(Path.dirname(keypairFile), { recursive: true })
      Fs.writeFileSync(
        keypairFile,
        JSON.stringify([...Keypair.generate().secretKey])
      )
    })
    return solanaPath
  }

  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.solanaValidator.planStart(
      Report.Actor.SolanaOutpost,
      "start-validator",
      "start solana-test-validator + the four wire-solana programs",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  describe("resolvePrograms", () => {
    let solanaPath: string
    let dataPath: string

    beforeAll(() => {
      solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "validator-programs-"))
      dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "validator-data-"))
      Fs.mkdirSync(
        Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
        { recursive: true }
      )
      SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program =>
        Fs.writeFileSync(
          SolanaOutpostProgramTool.programKeypairFile(solanaPath, program),
          JSON.stringify([...Keypair.generate().secretKey])
        )
      )
    })
    afterAll(() => {
      Fs.rmSync(solanaPath, { recursive: true, force: true })
      Fs.rmSync(dataPath, { recursive: true, force: true })
    })

    it("loads EVERY wire-solana program upgradeable under the ONE deployer", () => {
      const config = fixtureConfig({ solanaPath, dataPath }),
        programs = Steps.processes.solanaValidator.resolvePrograms(config),
        deployer =
          SolanaFundingTool.createDeployerKeypair(dataPath).publicKey.toBase58()
      expect(programs.map(program => program.name)).toEqual([
        ...SolanaOutpostProgramTool.GenesisAnchorPrograms
      ])
      SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach((name, index) => {
        const program = programs[index]
        expect(program.upgradeAuthority).toBe(deployer)
        expect(program.soFile).toBe(
          SolanaOutpostProgramTool.programSoFile(solanaPath, name)
        )
        expect(Fs.existsSync(program.soFile)).toBe(false)
        expect(program.programId).toBe(
          SolanaOutpostProgramTool.assertProgramId(solanaPath, name).toBase58()
        )
      })
    })

    it("throws with the build remediation when a program keypair is absent", () => {
      expect(() =>
        Steps.processes.solanaValidator.resolvePrograms(
          fixtureConfig({ solanaPath: "/no/such/wire-solana", dataPath })
        )
      ).toThrow(/program keypair missing/)
    })
  })
  describe("runStart", () => {
    afterEach(() => jest.restoreAllMocks())

    it("checks every genesis program before constructing the validator", async () => {
      const verified: string[] = [],
        verify = jest
          .spyOn(SolanaOutpostProgramTool, "assertProgramSoFile")
          .mockImplementation((_path, program) => {
            verified.push(program)
            return program
          }),
        create = jest
          .spyOn(SolanaValidatorProcess, "create")
          .mockRejectedValue(new Error("validator construction reached")),
        solanaPath = newUnbuiltSolanaPath("solana-verified-start-"),
        ctx = fixtureContext({
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
      ).rejects.toThrow("validator construction reached")
      expect(verified).toEqual([
        ...SolanaOutpostProgramTool.GenesisAnchorPrograms
      ])
      expect(verify).toHaveBeenCalledTimes(
        SolanaOutpostProgramTool.GenesisAnchorPrograms.length
      )
      expect(create).toHaveBeenCalledTimes(1)
      Fs.rmSync(solanaPath, { recursive: true, force: true })
    })

    it("refuses a stale sibling before constructing the validator", async () => {
      const verify = jest
          .spyOn(SolanaOutpostProgramTool, "assertProgramSoFile")
          .mockImplementation((_path, program) => {
            if (program === SolanaOutpostProgramTool.AnchorProgram.transferHook)
              throw new Error("transfer_hook binary differs from its build")
            return program
          }),
        create = jest.spyOn(SolanaValidatorProcess, "create"),
        ctx = fixtureContext({
          clusterPath: dir,
          dataPath: Path.join(dir, "data")
        })
      await expect(
        Steps.processes.solanaValidator.runStart(
          ctx,
          null,
          new AbortController().signal
        )
      ).rejects.toThrow("transfer_hook binary differs from its build")
      expect(verify).toHaveBeenCalledWith(
        ctx.config.solanaPath,
        SolanaOutpostProgramTool.AnchorProgram.transferHook
      )
      expect(create).not.toHaveBeenCalled()
    })

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
