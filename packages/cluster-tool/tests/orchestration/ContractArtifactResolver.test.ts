import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SysioContracts } from "@wireio/sdk-core"
import { ContractArtifactResolver } from "@wireio/cluster-tool/orchestration"

const { SysioContractName } = SysioContracts

describe("ContractArtifactResolver", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "artifacts-"))
    const epochDir = Path.join(dir, "contracts", "sysio.epoch")
    Fs.mkdirSync(epochDir, { recursive: true })
    Fs.writeFileSync(Path.join(epochDir, "sysio.epoch.wasm"), "")
    Fs.writeFileSync(Path.join(epochDir, "sysio.epoch.abi"), "{}")
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("resolves a contract to its account + wasm/abi paths under contracts/sysio.<name>", () => {
    const artifact = new ContractArtifactResolver(dir).resolve(SysioContractName.epoch)
    expect(artifact.account).toBe("sysio.epoch")
    expect(artifact.wasm).toBe(
      Path.join(dir, "contracts", "sysio.epoch", "sysio.epoch.wasm")
    )
    expect(artifact.abi.endsWith("sysio.epoch.abi")).toBe(true)
  })

  it("maps bios + system to the privileged sysio account (artifact dir stays sysio.<name>)", () => {
    const resolver = new ContractArtifactResolver(dir)
    expect(resolver.resolve(SysioContractName.bios).account).toBe("sysio")
    expect(resolver.resolve(SysioContractName.system).account).toBe("sysio")
    expect(resolver.resolve(SysioContractName.bios).wasm).toContain("sysio.bios")
  })

  it("exists reflects on-disk artifacts", () => {
    const resolver = new ContractArtifactResolver(dir)
    expect(resolver.exists(SysioContractName.epoch)).toBe(true)
    expect(resolver.exists(SysioContractName.token)).toBe(false)
  })
})
