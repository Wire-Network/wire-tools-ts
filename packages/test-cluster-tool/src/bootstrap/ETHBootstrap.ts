import { ethers } from "ethers"
import Path from "path"
import Fs from "fs"
import { AttestationType } from "@wireio/opp-solidity-models"
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
      "artifacts",
      "contracts",
      "outpost",
      `${name}.sol`,
      `${name}.json`
    )
    if (!Fs.existsSync(artifactFile)) {
      throw new Error(`Artifact not found: ${artifactFile}`)
    }
    const artifact = JSON.parse(Fs.readFileSync(artifactFile, "utf8"))
    return { abi: artifact.abi, bytecode: artifact.bytecode }
  }

  /** Deploy a single contract (upgradeable proxy pattern or direct) */
  private async deployDirect(
    name: string,
    args: any[] = []
  ): Promise<ethers.Contract> {
    log.info(`Deploying ${name}...`)
    const { abi, bytecode } = this.loadArtifact(name)
    const factory = new ethers.ContractFactory(
      abi,
      bytecode,
      this.client.signer
    )
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
      await this.client.signer.getAddress()
    ])

    // 2. Deploy OutpostManager (proxied via authority)
    const manager = await this.deployDirect("OutpostManager", [
      this.addr("OutpostManagerAuthority")
    ])

    // 3. Deploy OPP core
    const opp = await this.deployDirect("OPP", [
      this.addr("OutpostManagerAuthority"),
      360
    ])
    const oppInbound = await this.deployDirect("OPPInbound", [
      this.addr("OutpostManagerAuthority")
    ])

    // 4. Deploy OPP endpoints
    const operatorRegistry = await this.deployDirect("OperatorRegistry", [
      this.addr("OutpostManagerAuthority")
    ])
    const reserve = await this.deployDirect("Reserve", [
      this.addr("OutpostManagerAuthority")
    ])
    const bar = await this.deployDirect("BAR", [
      this.addr("OutpostManagerAuthority")
    ])

    // 5. Set up OPP roles via manager
    log.info("Configuring OPP roles...")
    const ownerAddr = await this.client.signer.getAddress()
    const authorityContract = authority.connect(this.client.signer) as any

    await retry(
      async () => {
        await authorityContract.managerHandoff(this.addr("OutpostManager"))
      },
      { label: "managerHandoff" }
    )

    const mgr = manager.connect(this.client.signer) as any
    await retry(
      async () => {
        await mgr.setupOPPRoles(this.addr("OPP"), this.addr("OPPInbound"))
      },
      { label: "setupOPPRoles" }
    )

    // 6. Configure OPP endpoints — use the typed AttestationType enum
    // from @wireio/opp-solidity-models (the regenerated bundle) so renames
    // propagate through the compiler rather than via parallel-maintained
    // magic numbers.
    log.info("Configuring OperatorRegistry endpoint...")
    await retry(
      async () => {
        await mgr.configureOPPEndpoint(
          this.addr("OperatorRegistry"),
          [AttestationType.OPERATOR_ACTION, AttestationType.UNDERWRITE_CONFIRM], // sends
          // OPERATOR_ACTION carries the full inbound surface: WITHDRAW_REMIT
          // (success-path withdraw return) + SLASH (depot-internal slash
          // routed to Reserve). DEPOSIT_REVERT rolls back local deposited
          // credit when the depot rejects a DEPOSIT_REQUEST (refunds depositor
          // minus a gas-penalty routed to Reserve).
          // OPERATORS roster is consumed exclusively by OPPInbound's
          // address-resolver cache.
          [AttestationType.OPERATOR_ACTION, AttestationType.DEPOSIT_REVERT, AttestationType.UNDERWRITE_INTENT] // receives
        )
      },
      { label: "configure OperatorRegistry" }
    )

    log.info("Configuring Reserve endpoint...")
    await retry(
      async () => {
        await mgr.configureOPPEndpoint(
          this.addr("Reserve"),
          [AttestationType.RESERVE_BALANCE_SHEET, AttestationType.SWAP_REJECTED], // sends
          [AttestationType.SWAP_REMIT] // receives
        )
      },
      { label: "configure Reserve" }
    )

    log.info("Configuring BAR endpoint...")
    await retry(
      async () => {
        await mgr.configureOPPEndpoint(
          this.addr("BAR"),
          [AttestationType.OPERATOR_ACTION], // sends
          [] // receives nothing
        )
      },
      { label: "configure BAR" }
    )

    // 7. Configuration role grant. (OperatorRegistry no longer needs to be
    //    registered with OPPInbound — per-operator bond weighting moved
    //    off-chain to WIRE JSON-RPC; on-chain consensus uses equal weight.)
    log.info("Setting OperatorRegistry on OPPInbound...")
    await retry(
      async () => {
        await mgr.grantRole(await mgr.CONFIGURATION_ROLE(), ownerAddr)
      },
      { label: "grant CONFIGURATION_ROLE" }
    )

    // Fund the reserve with some ETH for testing
    log.info("Funding Reserve with 100 ETH...")
    await this.client.signer.sendTransaction({
      to: this.addr("Reserve"),
      value: ethers.parseEther("100")
    })

    log.info("=== Ethereum Outpost Bootstrap Complete ===")
    log.info("Deployed contracts:")
    Object.entries(this.deployed).forEach(([name, { address }]) =>
      log.info(`  ${name}: ${address}`)
    )
  }
}
