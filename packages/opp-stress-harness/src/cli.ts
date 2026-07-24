#!/usr/bin/env node
import { APIClient, createClassicSigner, PrivateKey } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  collectOppEnvelopeSaturationMetrics,
  type OppEnvelopeSaturationWindow
} from "@wireio/test-opp-stress"
import { JsonRpcProvider, Wallet } from "ethers"
import Yargs from "yargs"
import { hideBin } from "yargs/helpers"

import { apiChainEnvelopeReader } from "./apiChainEnvelopeReader.js"
import { chainEnvelopeSource } from "./chainEnvelopeSource.js"
import {
  formatThroughputSummary,
  readEnvelopeThroughput
} from "./envelopeThroughput.js"
import {
  createEthLoadWallets,
  createLoadWalletKeys,
  EthLoadWalletFileVersion,
  formatWireAsset,
  fundEthWallet,
  LoadWalletFileVersion,
  provisionLoadWallet,
  readEthLoadWalletFile,
  readLoadWalletFile,
  resolveGasPrice,
  runEthSwapLoad,
  runSwapLoad,
  saveEthLoadWalletFile,
  saveLoadWalletFile,
  sweepEthWallet,
  sweepLoadWallet,
  type EthSweepResult,
  type LoadWallet,
  type ProvisionOptions,
  type SweepResult
} from "./load/index.js"
import { formatSaturationSummary } from "./saturationReport.js"

const log = getLogger("wire-opp-stress"),
  ByteThresholdStrategy = "byte_threshold" as const,
  NodeOwnerKeyEnv = "WIRE_NODE_OWNER_KEY",
  EthFunderKeyEnv = "WIRE_ETH_FUNDER_KEY",
  FailureExitCode = 2

/** Emit a line of output on stdout. */
function emit(text: string): void {
  process.stdout.write(`${text}\n`)
}

/** Run a command body, converting any failure into a logged non-zero exit. */
async function guard(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    log.error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = FailureExitCode
  }
}

/** Resolve a private key from an explicit flag or its environment variable. */
function resolveKey(explicit: string | undefined, envName: string, flag: string): string {
  const key = explicit ?? process.env[envName]
  if (key === undefined || key.length === 0)
    throw new Error(`key required: set ${envName} or pass ${flag}`)
  return key
}

/** Build a WIRE client that signs as the supplied private key. */
function wireSigningClient(url: string, privateKey: string): APIClient {
  return new APIClient({
    url,
    signer: createClassicSigner(PrivateKey.from(privateKey))
  })
}

void Yargs(hideBin(process.argv))
  .scriptName("wire-opp-stress")
  .command(
    "saturation",
    "Report depot->outpost OPP envelope byte-saturation over un-privileged RPC",
    builder =>
      builder
        .option("url", { type: "string", demandOption: true, describe: "WIRE depot HTTP RPC URL" })
        .option("epoch-start", { type: "number", describe: "Inclusive epoch lower bound" })
        .option("epoch-end", { type: "number", describe: "Inclusive epoch upper bound" })
        .option("json", { type: "boolean", default: false, describe: "Emit the full metrics object as JSON" }),
    argv =>
      guard("saturation", async () => {
        const source = chainEnvelopeSource(apiChainEnvelopeReader(new APIClient({ url: argv.url }))),
          window: OppEnvelopeSaturationWindow = {
            saturationStrategy: ByteThresholdStrategy,
            ...(argv.epochStart === undefined ? {} : { epochStart: argv.epochStart }),
            ...(argv.epochEnd === undefined ? {} : { epochEnd: argv.epochEnd })
          },
          metrics = await collectOppEnvelopeSaturationMetrics(source, window)
        emit(argv.json ? JSON.stringify(metrics) : formatSaturationSummary(metrics))
      })
  )
  .command(
    "throughput",
    "Report inbound/outbound OPP envelope counts per epoch (the ETH-load lens)",
    builder =>
      builder
        .option("url", { type: "string", demandOption: true, describe: "WIRE depot HTTP RPC URL" })
        .option("json", { type: "boolean", default: false, describe: "Emit the snapshot as JSON" }),
    argv =>
      guard("throughput", async () => {
        const snapshot = await readEnvelopeThroughput(new APIClient({ url: argv.url }))
        emit(argv.json ? JSON.stringify(snapshot) : formatThroughputSummary(snapshot))
      })
  )
  .command(
    "wire-provision",
    "Create, resource, and fund WIRE-sourced load wallets (needs a tier-1 node owner key)",
    builder =>
      builder
        .option("url", { type: "string", demandOption: true, describe: "WIRE depot HTTP RPC URL" })
        .option("node-owner", { type: "string", demandOption: true, describe: "Tier-1 node owner account (creator, issuer, funder)" })
        .option("node-owner-key", { type: "string", describe: `Node owner active key; prefer the ${NodeOwnerKeyEnv} env var` })
        .option("wallets", { type: "number", demandOption: true, describe: "Number of load wallets to create" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Path to write the generated wallet set (holds private keys)" })
        .option("fund-amount", { type: "string", default: "500000000", describe: "WIRE per wallet, 9-decimal base units" })
        .option("nonce-prefix", { type: "string", default: "ld", describe: "Name-safe run label; reusing it makes provisioning idempotent" })
        .option("policy-net", { type: "string", default: "1.0000 SYS", describe: "NET weight per wallet" })
        .option("policy-cpu", { type: "string", default: "1.0000 SYS", describe: "CPU weight per wallet" })
        .option("policy-ram", { type: "string", default: "1.0000 SYS", describe: "RAM weight per wallet" }),
    argv =>
      guard("wire-provision", async () => {
        const client = wireSigningClient(argv.url, resolveKey(argv.nodeOwnerKey, NodeOwnerKeyEnv, "--node-owner-key")),
          options: ProvisionOptions = {
            nodeOwner: argv.nodeOwner,
            funder: argv.nodeOwner,
            fundAmount: BigInt(argv.fundAmount),
            policy: { net: argv.policyNet, cpu: argv.policyCpu, ram: argv.policyRam },
            noncePrefix: argv.noncePrefix
          },
          keys = createLoadWalletKeys(argv.wallets),
          wallets = await keys.reduce<Promise<readonly LoadWallet[]>>(async (pending, key) => {
            const done = await pending,
              wallet = await provisionLoadWallet(client, options, key)
            log.info(`provisioned ${wallet.account} (${done.length + 1}/${keys.length})`)
            return [...done, wallet]
          }, Promise.resolve([]))
        saveLoadWalletFile(argv.walletFile, {
          version: LoadWalletFileVersion,
          noncePrefix: argv.noncePrefix,
          funder: argv.nodeOwner,
          wallets
        })
        emit(`provisioned ${wallets.length} wire wallets funded ${formatWireAsset(options.fundAmount)} each -> ${argv.walletFile}`)
      })
  )
  .command(
    "wire-run",
    "Drive WIRE wallets through swapfromwire (depot->outpost; saturation-visible)",
    builder =>
      builder
        .option("url", { type: "string", demandOption: true, describe: "WIRE depot HTTP RPC URL" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Wallet set from wire-provision" })
        .option("swaps-per-wallet", { type: "number", default: 1, describe: "Swaps each wallet performs" })
        .option("concurrency", { type: "number", default: 8, describe: "Maximum swaps in flight" })
        .option("dst-chain", { type: "string", default: "ETHEREUM", describe: "Destination chain slug" })
        .option("dst-token", { type: "string", default: "ETH", describe: "Destination token slug" })
        .option("dst-reserve", { type: "string", default: "PRIMARY", describe: "Destination reserve slug" })
        .option("wire-amount", { type: "string", default: "100000000", describe: "Source WIRE per swap, 9-decimal base units" })
        .option("target-amount", { type: "string", default: "1", describe: "Minimum destination amount; must be > 0" })
        .option("tolerance-bps", { type: "number", default: 500, describe: "Variance tolerance in basis points" })
        .option("json", { type: "boolean", default: false, describe: "Emit the run result as JSON" }),
    argv =>
      guard("wire-run", async () => {
        const file = readLoadWalletFile(argv.walletFile),
          result = await runSwapLoad({
            url: argv.url,
            wallets: file.wallets,
            route: { chain: argv.dstChain, token: argv.dstToken, reserve: argv.dstReserve },
            amounts: { wireAmount: BigInt(argv.wireAmount), targetAmount: BigInt(argv.targetAmount), toleranceBps: argv.toleranceBps },
            swapsPerWallet: argv.swapsPerWallet,
            concurrency: argv.concurrency
          })
        result.failures.forEach(failure => log.warn(`swap failed ${failure.identity} round ${failure.round}: ${failure.reason}`))
        emit(argv.json ? JSON.stringify(result) : `submitted ${result.submitted}, accepted ${result.accepted.length}, failed ${result.failures.length}`)
      })
  )
  .command(
    "wire-sweep",
    "Return residual WIRE from every WIRE load wallet to the funding account",
    builder =>
      builder
        .option("url", { type: "string", demandOption: true, describe: "WIRE depot HTTP RPC URL" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Wallet set from wire-provision" })
        .option("to", { type: "string", describe: "Destination account; defaults to the wallet file's funder" })
        .option("json", { type: "boolean", default: false, describe: "Emit the sweep result as JSON" }),
    argv =>
      guard("wire-sweep", async () => {
        const file = readLoadWalletFile(argv.walletFile),
          destination = argv.to ?? file.funder,
          results = await file.wallets.reduce<Promise<readonly SweepResult[]>>(
            async (pending, wallet) => [...(await pending), await sweepLoadWallet(argv.url, wallet, destination)],
            Promise.resolve([])
          ),
          returned = results.reduce((total, entry) => total + entry.returned, 0n)
        emit(argv.json
          ? JSON.stringify({ destination, returned: returned.toString(), results: results.map(r => ({ ...r, returned: r.returned.toString() })) })
          : `swept ${formatWireAsset(returned)} from ${results.length} wire wallets -> ${destination}`)
      })
  )
  .command(
    "eth-provision",
    "Generate and ETH-fund Ethereum-sourced load wallets (un-privileged; free EOAs)",
    builder =>
      builder
        .option("eth-url", { type: "string", demandOption: true, describe: "Ethereum outpost JSON-RPC URL" })
        .option("recipient", { type: "string", demandOption: true, describe: "Existing WIRE account every swap delivers to" })
        .option("funder-key", { type: "string", describe: `ETH funder private key; prefer the ${EthFunderKeyEnv} env var` })
        .option("wallets", { type: "number", demandOption: true, describe: "Number of source EOAs to generate" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Path to write the generated wallet set (holds private keys)" })
        .option("fund-wei", { type: "string", demandOption: true, describe: "ETH per wallet in wei (cover swap value + gas)" }),
    argv =>
      guard("eth-provision", async () => {
        const provider = new JsonRpcProvider(argv.ethUrl),
          funder = new Wallet(resolveKey(argv.funderKey, EthFunderKeyEnv, "--funder-key"), provider),
          amountWei = BigInt(argv.fundWei),
          wallets = createEthLoadWallets(argv.wallets)
        // Sequential: the funder's nonces must increment in order.
        await wallets.reduce<Promise<void>>(async (pending, wallet) => {
          await pending
          const tx = await fundEthWallet(funder, wallet.address, amountWei)
          await tx.wait()
          log.info(`funded ${wallet.address} (${wallet.index + 1}/${wallets.length})`)
        }, Promise.resolve())
        saveEthLoadWalletFile(argv.walletFile, {
          version: EthLoadWalletFileVersion,
          funder: funder.address,
          recipient: argv.recipient,
          wallets
        })
        emit(`funded ${wallets.length} eth wallets ${amountWei} wei each -> ${argv.walletFile}`)
      })
  )
  .command(
    "eth-run",
    "Drive Ethereum EOAs through requestSwap (outpost->depot; throughput lens)",
    builder =>
      builder
        .option("eth-url", { type: "string", demandOption: true, describe: "Ethereum outpost JSON-RPC URL" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Wallet set from eth-provision" })
        .option("reserve-manager", { type: "string", demandOption: true, describe: "Deployed ReserveManager contract address" })
        .option("swaps-per-wallet", { type: "number", default: 1, describe: "Swaps each wallet performs" })
        .option("concurrency", { type: "number", default: 8, describe: "Maximum swaps in flight" })
        .option("value-wei", { type: "string", default: "100000000000000000", describe: "Source ETH per swap in wei (msg.value)" })
        .option("src-token", { type: "string", default: "ETH", describe: "Native source token slug" })
        .option("src-reserve", { type: "string", default: "PRIMARY", describe: "Source reserve slug" })
        .option("dst-chain", { type: "string", default: "WIRE", describe: "Destination chain slug" })
        .option("dst-token", { type: "string", default: "WIRE", describe: "Destination token slug" })
        .option("dst-reserve", { type: "string", default: "PRIMARY", describe: "Destination reserve slug" })
        .option("target-amount", { type: "string", default: "1", describe: "Minimum destination amount; must be > 0" })
        .option("tolerance-bps", { type: "number", default: 500, describe: "Variance tolerance in basis points" })
        .option("json", { type: "boolean", default: false, describe: "Emit the run result as JSON" }),
    argv =>
      guard("eth-run", async () => {
        const file = readEthLoadWalletFile(argv.walletFile),
          result = await runEthSwapLoad({
            url: argv.ethUrl,
            reserveManager: argv.reserveManager,
            recipient: file.recipient,
            wallets: file.wallets,
            route: { sourceToken: argv.srcToken, sourceReserve: argv.srcReserve, targetChain: argv.dstChain, targetToken: argv.dstToken, targetReserve: argv.dstReserve },
            amounts: { valueWei: BigInt(argv.valueWei), targetAmount: BigInt(argv.targetAmount), toleranceBps: argv.toleranceBps },
            swapsPerWallet: argv.swapsPerWallet,
            concurrency: argv.concurrency
          })
        result.failures.forEach(failure => log.warn(`swap failed ${failure.identity} round ${failure.round}: ${failure.reason}`))
        emit(argv.json ? JSON.stringify(result) : `submitted ${result.submitted}, accepted ${result.accepted.length}, failed ${result.failures.length}`)
      })
  )
  .command(
    "eth-sweep",
    "Return residual ETH from every Ethereum load wallet to the funder",
    builder =>
      builder
        .option("eth-url", { type: "string", demandOption: true, describe: "Ethereum outpost JSON-RPC URL" })
        .option("wallet-file", { type: "string", demandOption: true, describe: "Wallet set from eth-provision" })
        .option("to", { type: "string", describe: "Destination address; defaults to the wallet file's funder" })
        .option("json", { type: "boolean", default: false, describe: "Emit the sweep result as JSON" }),
    argv =>
      guard("eth-sweep", async () => {
        const file = readEthLoadWalletFile(argv.walletFile),
          provider = new JsonRpcProvider(argv.ethUrl),
          destination = argv.to ?? file.funder,
          gasPrice = await resolveGasPrice(provider),
          results = await file.wallets.reduce<Promise<readonly EthSweepResult[]>>(
            async (pending, wallet) => [...(await pending), await sweepEthWallet(provider, wallet, destination, gasPrice)],
            Promise.resolve([])
          ),
          returned = results.reduce((total, entry) => total + entry.returned, 0n)
        emit(argv.json
          ? JSON.stringify({ destination, returned: returned.toString(), results: results.map(r => ({ ...r, returned: r.returned.toString() })) })
          : `swept ${returned} wei from ${results.length} eth wallets -> ${destination}`)
      })
  )
  .demandCommand(1, "Specify a command")
  .strict()
  .help()
  .parseAsync()
