import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import {
  SolanaFundingTool,
  SolanaOutpostProgramTool
} from "@wireio/cluster-tool/tools/solana"
import { fixtureConfig } from "../../../config/clusterConfigFixture.js"

describe("Steps.processes.solanaValidator", () => {
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
})
