import Fs from "node:fs"
import Path from "node:path"
import { SysioContracts } from "@wireio/sdk-core"

const { SysioContractAccount } = SysioContracts

/** A resolved contract's deploy target + compiled artifact paths. */
export interface ContractArtifact {
  /** The contract (short name). */
  readonly contract: SysioContracts.SysioContractName
  /** On-chain deploy account (`sysio.<name>`, or `sysio` for bios/system). */
  readonly account: string
  /** Path to the compiled `.wasm`. */
  readonly wasm: string
  /** Path to the `.abi` JSON. */
  readonly abi: string
}

/**
 * Resolves a {@link SysioContracts.SysioContractName} to its compiled artifacts
 * under `<buildPath>/contracts/sysio.<name>/sysio.<name>.{wasm,abi}` — the
 * production layout the bootstrap deploys from. The deploy ACCOUNT comes from
 * `SysioContractAccount` (so `bios`/`system` target `sysio`), while the artifact
 * DIRECTORY is always `sysio.<name>`.
 */
export class ContractArtifactResolver {
  constructor(readonly buildPath: string) {}

  /** Artifact directory for a contract: `<buildPath>/contracts/sysio.<name>`. */
  private directory(contract: SysioContracts.SysioContractName): string {
    return Path.join(this.buildPath, "contracts", `sysio.${contract}`)
  }

  /** Resolve a contract's account + wasm/abi paths (paths not checked for existence). */
  resolve(contract: SysioContracts.SysioContractName): ContractArtifact {
    const directory = this.directory(contract),
      base = `sysio.${contract}`
    return {
      contract,
      account: SysioContractAccount[contract],
      wasm: Path.join(directory, `${base}.wasm`),
      abi: Path.join(directory, `${base}.abi`)
    }
  }

  /** Whether both the `.wasm` and `.abi` exist for a contract. */
  exists(contract: SysioContracts.SysioContractName): boolean {
    const { wasm, abi } = this.resolve(contract)
    return Fs.existsSync(wasm) && Fs.existsSync(abi)
  }
}
