import { ethers } from "ethers"
import Path from "path"
import Fs from "fs"
import { ETHClient } from "../clients/ETHClient.js"
import { log } from "../logger.js"
import { retry } from "../util.js"

/**
 * Ethereum outpost bootstrap.
 *
 * Deploys the full OPP outpost stack on anvil using compiled artifacts
 * from wire-ethereum. Mirrors the Deployer + OutpostDefaults pattern.
 */

export interface ETHBootstrapConfig {
  /** Path to wire-ethereum repo root */
  wireEthPath: string
  /** RPC URL of the anvil instance */
  rpcUrl: string
  /** Private key for deployer (default: anvil key 0) */
  deployerKey?: string
}

interface DeployedContracts {
  [name: string]: {
    address: string
    contract: ethers.Contract
  }
}

export class ETHBootstrap {
  private client: ETHClient
  private config: ETHBootstrapConfig
  private deployed: DeployedContracts = {}

  constructor(config: ETHBootstrapConfig) {
    this.config = config
    this.client = new ETHClient(config.rpcUrl, config.deployerKey)
  }

  get contracts(): DeployedContracts {
    return this.deployed
  }

  get ethClient(): ETHClient {
    return this.client
  }

  /** Load contract ABI + bytecode from hardhat artifacts */
  private loadArtifact(name: string): { abi: any[]; bytecode: string } {
    const artifactFile = Path.join(
      this.config.wireEthPath,
      "artifacts", "contracts", "outpost", `${name}.sol`, `${name}.json`
    )
    if (!Fs.existsSync(artifactFile)) {
      throw new Error(`Artifact not found: ${artifactFile}`)
    }
    const artifact = JSON.parse(Fs.readFileSync(artifactFile, "utf8"))
    return { abi: artifact.abi, bytecode: artifact.bytecode }
  }

  /** Deploy a single contract (upgradeable proxy pattern or direct) */
  private async deployDirect(name: string, args: any[] = []): Promise<ethers.Contract> {
    log.info(`Deploying ${name}...`)
    const { abi, bytecode } = this.loadArtifact(name)
    const factory = new ethers.ContractFactory(abi, bytecode, this.client.signer)
    const deployed = await factory.deploy(...args)
    await deployed.waitForDeployment()
    const addr = await deployed.getAddress()
    const contract = new ethers.Contract(addr, abi, this.client.signer)
    this.deployed[name] = { address: addr, contract }
    log.info(`  ${name} deployed at ${addr}`)
    return contract
  }

  /** Get address of a deployed contract */
  private addr(name: string): string {
    const d = this.deployed[name]
    if (!d) throw new Error(`Contract ${name} not deployed yet`)
    return d.address
  }

  /** Run the full ETH outpost deployment */
  async bootstrap(): Promise<void> {
    log.info("=== Ethereum Outpost Bootstrap ===")

    // 1. Deploy authority
    const authority = await this.deployDirect("OutpostManagerAuthority", [
      await this.client.signer.getAddress(),
    ])

    // 2. Deploy OutpostManager (proxied via authority)
    const manager = await this.deployDirect("OutpostManager", [this.addr("OutpostManagerAuthority")])

    // 3. Deploy OPP core
    const opp = await this.deployDirect("OPP", [this.addr("OutpostManagerAuthority"), 360])
    const oppInbound = await this.deployDirect("OPPInbound", [this.addr("OutpostManagerAuthority")])

    // 4. Deploy OPP endpoints
    const operatorRegistry = await this.deployDirect("OperatorRegistry", [this.addr("OutpostManagerAuthority")])
    const outpostReserve = await this.deployDirect("OutpostReserve", [this.addr("OutpostManagerAuthority")])
    const bar = await this.deployDirect("BAR", [this.addr("OutpostManagerAuthority")])

    // 5. Set up OPP roles via manager
    log.info("Configuring OPP roles...")
    const ownerAddr = await this.client.signer.getAddress()
    const authorityContract = authority.connect(this.client.signer) as any

    await retry(async () => {
      await authorityContract.managerHandoff(this.addr("OutpostManager"))
    }, { label: "managerHandoff" })

    const mgr = manager.connect(this.client.signer) as any
    await retry(async () => {
      await mgr.setupOPPRoles(this.addr("OPP"), this.addr("OPPInbound"))
    }, { label: "setupOPPRoles" })

    // 6. Configure OPP endpoints with attestation types
    // AttestationType enum values (from protobuf)
    const OPERATOR_ACTION = 2001
    const RESERVE_BALANCE_SHEET = 43520
    const UNDERWRITE_INTENT = 60935
    const UNDERWRITE_CONFIRM = 60936
    const SLASH_OPERATOR = 60933
    const ROSTER_UPDATE = 60941
    const REMIT = 60938
    const REMIT_CONFIRM = 60942

    log.info("Configuring OperatorRegistry endpoint...")
    await retry(async () => {
      await mgr.configureOPPEndpoint(
        this.addr("OperatorRegistry"),
        [OPERATOR_ACTION, UNDERWRITE_CONFIRM],         // sends
        [UNDERWRITE_INTENT, SLASH_OPERATOR, ROSTER_UPDATE] // receives
      )
    }, { label: "configure OperatorRegistry" })

    log.info("Configuring OutpostReserve endpoint...")
    await retry(async () => {
      await mgr.configureOPPEndpoint(
        this.addr("OutpostReserve"),
        [RESERVE_BALANCE_SHEET, REMIT_CONFIRM],  // sends
        [REMIT]                                   // receives
      )
    }, { label: "configure OutpostReserve" })

    log.info("Configuring BAR endpoint...")
    await retry(async () => {
      await mgr.configureOPPEndpoint(
        this.addr("BAR"),
        [OPERATOR_ACTION],  // sends
        []                  // receives nothing
      )
    }, { label: "configure BAR" })

    // 7. Set OperatorRegistry on OPPInbound for queryBond
    log.info("Setting OperatorRegistry on OPPInbound...")
    await retry(async () => {
      await mgr.grantRole(await mgr.CONFIGURATION_ROLE(), ownerAddr)
    }, { label: "grant CONFIGURATION_ROLE" })

    // Fund the reserve with some ETH for testing
    log.info("Funding OutpostReserve with 100 ETH...")
    await this.client.signer.sendTransaction({
      to: this.addr("OutpostReserve"),
      value: ethers.parseEther("100"),
    })

    log.info("=== Ethereum Outpost Bootstrap Complete ===")
    log.info("Deployed contracts:")
    for (const [name, { address }] of Object.entries(this.deployed)) {
      log.info(`  ${name}: ${address}`)
    }
  }
}
