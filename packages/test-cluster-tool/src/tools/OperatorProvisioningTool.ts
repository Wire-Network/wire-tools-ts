/**
 * OperatorProvisioningTool — provision a fresh **non-bootstrapped** WIRE
 * operator with paired ETH + SOL identities for flow-* scenarios that
 * exercise the deposit / collateral / termination lifecycle.
 *
 * Per `.claude/rules/flow-test-scenario-structure.md` and
 * `wire/.claude/rules/bootstrapped-operator-invariants.md`:
 *   - The harness substrate registers all default batch operators with
 *     `is_bootstrapped: true`. Those genesis operators are privileged
 *     and the depot's `sysio.opreg::depositinle` rejects deposits to
 *     them ("bootstrapped operator cannot accept deposits").
 *   - Scenarios that exercise the deposit path therefore have to
 *     provision their own NON-BOOTSTRAPPED operator in `beforeAll`.
 *
 * This helper composes the 7 surfaces needed:
 *   1. WIRE wallet open + unlock.
 *   2. `sysio::newaccount` for the operator's WIRE account name.
 *   3. `sysio.roa::addpolicy` resource policy from the bootstrap node owner.
 *   4. ETH HD wallet derivation at an unused slot (default past every
 *      cluster-allocated slot).
 *   5. SOL ED25519 keypair generation + airdrop.
 *   6. Authex link for both ETH and SOL (so the depot's `bypubkey`
 *      index resolves deposit attestations back to this account).
 *   7. `sysio.opreg::regoperator(is_bootstrapped: false)` signed as
 *      `sysio.opreg@active` (privileged registration).
 *
 * Idempotent on the "account already exists" branch — re-running a
 * flow against an existing cluster directory reuses the operator.
 */

import Assert from "node:assert"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { ethers } from "ethers"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey
} from "@solana/web3.js"
import {
  Bytes,
  KeyType,
  PrivateKey,
  SystemContracts
} from "@wireio/sdk-core"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import type { FlowTestContext } from "../FlowTestContext.js"
import { BOOTSTRAP_NODE_OWNER } from "../cluster/constants.js"
import { ETHBootstrapper } from "../cluster/ETHBootstrapper.js"
import { createAuthExLink } from "./AuthExLinkTool.js"
import { ProcessManager } from "../processes/ProcessManager.js"
import { waitForEndpoint } from "../util.js"
import { log } from "../logger.js"

/**
 * Result of {@link provisionFreshBatchOperator}.
 */
export interface FreshBatchOperator {
  /** WIRE account name (≤12 chars, must be unused at provisioning time). */
  account:             string
  /** Ethereum wallet — connected to the harness's `ethProvider`. */
  ethWallet:           ethers.HDNodeWallet
  /** 33-byte compressed secp256k1 pubkey for `OperatorRegistry.deposit`. */
  ethCompressedPubkey: Uint8Array
  /** Solana keypair, airdrop-funded above the configured floor. */
  solKeypair:          Keypair
  /** 32-byte ed25519 pubkey (`solKeypair.publicKey`). */
  solPublicKey:        PublicKey
}

/**
 * Provisioning input. Sensible defaults cover the common
 * "single non-bootstrapped batch op" need; flows that need
 * multiple fresh operators call this helper N times with
 * distinct `account` + `ethHdIndex` values.
 */
export interface FreshBatchOperatorOptions {
  /**
   * WIRE account name (≤12 chars; bootstrap registers
   * `batchop.[a-i]` so `freshop` / `depositor` / etc. slot in
   * cleanly without collision).
   */
  account:             string
  /**
   * HD index for the ETH wallet on the anvil mnemonic. Must be
   * past every operator slot the cluster has allocated:
   *   - bootstrap allocates batchops at slots 1..N
   *   - underwriters at N+1..N+M
   *   - `SwapUserIdentities` defaults to slot 32
   * Pick anything ≥ `DefaultEthHdIndex` (35 by default) that no
   * other flow-* helper has taken.
   */
  ethHdIndex:          number
  /**
   * Minimum lamport balance to hold on the SOL keypair after
   * airdrop. The default (5 SOL) covers any reasonable deposit
   * amount + a generous tx-fee budget.
   */
  solAirdropFloor?:    number
  /**
   * Solana RPC connection. If omitted, derived from
   * `ctx.ports.solanaRpc`.
   */
  solConnection?:      Connection
  /**
   * Wei to seed into the operator's ETH wallet via a
   * `signer(0).sendTransaction` from anvil's deployer. HD indices
   * past 9 aren't part of anvil's auto-funded set, so any deposit
   * call would otherwise revert on insufficient gas + msg.value.
   * Default ~1 ETH covers a deposit + ample tx fees.
   */
  ethFundWei?:         bigint
}

export namespace OperatorProvisioning {
  /**
   * Default starting ETH HD index for fresh operators. Past every
   * operator slot allocated by the harness (≤ 31) and past the
   * default `SwapUserIdentities` slot (32). Flows requesting
   * multiple fresh ops should walk this base upward.
   */
  export const DefaultEthHdIndex     = 35
  /** Default SOL airdrop floor — 5 SOL is plenty for tx fees. */
  export const DefaultSolAirdropFloor = 5 * LAMPORTS_PER_SOL
  /** Default ETH funding — ~1 ETH covers any deposit + ample gas. */
  export const DefaultEthFundWei      = 10n ** 18n
  /** Bootstrap node owner that issues the ROA policy for new accounts (single source: constants.ts). */
  export const BootstrapNodeOwner     = BOOTSTRAP_NODE_OWNER
  /** Dev K1 pubkey loaded into kiod at bootstrap; used as owner/active. */
  export const DevK1PublicKey         =
    "SYS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"
  /** Deadline + interval for the SOL airdrop confirmation poll. */
  export const AirdropConfirmTimeoutMs      = 30_000
  export const AirdropConfirmPollIntervalMs = 500
}

/**
 * Provision a fresh non-bootstrapped batch operator with paired
 * ETH + SOL identities. Runs every step inline; on the
 * "account already exists" branch falls through to reuse the
 * existing on-chain registration (useful for re-runs against an
 * existing cluster directory).
 *
 * MUST be called from a flow's `beforeAll`, AFTER
 * `FlowTestContext.create(...)` has returned a ready cluster.
 *
 * @param ctx     - Active FlowTestContext (cluster up + bootstrap done).
 * @param options - Provisioning shape (account name + HD index + airdrop floor).
 * @returns       - Fresh operator identity for the test to deposit / withdraw against.
 *
 * @example
 *   beforeAll(async () => {
 *     ctx = await FlowTestContext.create({ epochDurationSec: 30 })
 *     freshOp = await provisionFreshBatchOperator(ctx, {
 *       account:    "depositor",
 *       ethHdIndex: 35
 *     })
 *   }, BootstrapTimeoutMs)
 */
export async function provisionFreshBatchOperator(
  ctx:     FlowTestContext,
  options: FreshBatchOperatorOptions
): Promise<FreshBatchOperator> {
  const account         = options.account
  const ethHdIndex      = options.ethHdIndex
  const airdropFloor    = options.solAirdropFloor
    ?? OperatorProvisioning.DefaultSolAirdropFloor
  const solConnection   = options.solConnection
    ?? new Connection(`http://127.0.0.1:${ctx.ports.solanaRpc}`, "confirmed")
  const ethFundWei      = options.ethFundWei
    ?? OperatorProvisioning.DefaultEthFundWei

  Assert.ok(account.length > 0 && account.length <= 12,
    `provisionFreshBatchOperator: account "${account}" must be 1..12 chars`)
  Assert.ok(Number.isInteger(ethHdIndex) && ethHdIndex > 0,
    `provisionFreshBatchOperator: ethHdIndex must be a positive integer (got ${ethHdIndex})`)
  Assert.ok(ctx.ethProvider,
    "provisionFreshBatchOperator: ctx.ethProvider is required")

  // 1) Wallet open + unlock so subsequent clio-signed actions complete.
  await ctx.wireClient.clio.walletOpenAndUnlock("default")

  // 2) WIRE account creation. Tolerate the "already exists" branch
  //    so the helper is idempotent across re-runs.
  try {
    await ctx.wireClient.clio.createAccount(
      "sysio",
      account,
      OperatorProvisioning.DevK1PublicKey,
      OperatorProvisioning.DevK1PublicKey
    )
  } catch (err: any) {
    if (!(err?.message ?? "").includes("already exists")) {
      throw new Error(
        `provisionFreshBatchOperator: createAccount(${account}) failed: ${err?.message ?? err}`
      )
    }
  }

  // 3) Resource policy from the bootstrap node owner — every
  //    operator account needs this to push actions on its own
  //    permission level. `_weight` fields are sysio.token assets,
  //    enforced at compile time by the strongly-typed generic
  //    (per feedback_strongly_typed_contract_actions.md).
  await ctx.wireClient.clio.pushActionAndWait<
    SystemContracts.SysioRoaAddpolicyAction
  >(
    "sysio.roa",
    "addpolicy",
    {
      owner:       account,
      issuer:      OperatorProvisioning.BootstrapNodeOwner,
      net_weight:  "25.0000 SYS",
      ram_weight:  "25.0000 SYS",
      cpu_weight:  "25.0000 SYS",
      time_block:  0,
      network_gen: 0
    },
    `${OperatorProvisioning.BootstrapNodeOwner}@active`
  )

  // 4) ETH HD wallet derivation at the requested slot.
  const mnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic)
  const ethWallet = ethers.HDNodeWallet
    .fromMnemonic(mnemonic, `${ETHBootstrapper.DerivationPath}${ethHdIndex}`)
    .connect(ctx.ethProvider)
  const compressedHex = ethers.SigningKey.computePublicKey(
    ethWallet.publicKey,
    /*compressed=*/ true
  )
  const ethCompressedPubkey = ethers.getBytes(
    compressedHex.startsWith("0x") ? compressedHex : `0x${compressedHex}`
  )

  // 4b) Seed the operator's ETH wallet from anvil's deployer signer.
  // HD indices > 9 aren't part of anvil's auto-funded set, so the
  // wallet starts at 0 balance and any deposit / withdraw tx would
  // revert on insufficient gas. Skip when `ethFundWei == 0` (caller
  // explicitly opted out of funding).
  if (ethFundWei > 0n) {
    const funder = await ctx.ethProvider.getSigner(0)
    const fundTx = await funder.sendTransaction({
      to:    ethWallet.address,
      value: ethFundWei
    })
    await fundTx.wait()
  }

  // 5) SOL keypair + airdrop. Funded above the configured floor so
  //    the operator's wallet covers deposit + several tx fees.
  const solSdkKey   = PrivateKey.generate(KeyType.ED)
  const solKeypair  = Keypair.fromSecretKey(solSdkKey.data.array)
  const solPublicKey = solKeypair.publicKey
  const airdropSig  = await solConnection.requestAirdrop(solPublicKey, airdropFloor)
  const deadlineMs  = Date.now() + OperatorProvisioning.AirdropConfirmTimeoutMs
  while (Date.now() < deadlineMs) {
    const status = await solConnection.getSignatureStatus(airdropSig)
    const conf   = status?.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") break
    if (status?.value?.err) {
      throw new Error(
        `provisionFreshBatchOperator: airdrop tx failed for ${solPublicKey.toBase58()}: ${JSON.stringify(status.value.err)}`
      )
    }
    await new Promise(resolve =>
      setTimeout(resolve, OperatorProvisioning.AirdropConfirmPollIntervalMs)
    )
  }
  const solBalance = await solConnection.getBalance(solPublicKey)
  Assert.ok(solBalance >= airdropFloor,
    `provisionFreshBatchOperator: airdrop landed ${solBalance} < floor ${airdropFloor} for ${solPublicKey.toBase58()}`)

  // 6) Authex link for ETH — signs with the secp256k1 EM-flavored key.
  const ethPrivHex = ethWallet.privateKey.startsWith("0x")
    ? ethWallet.privateKey.slice(2)
    : ethWallet.privateKey
  const emPriv = PrivateKey.regenerate(
    KeyType.EM,
    Bytes.fromString(ethPrivHex, "hex")
  )
  await createAuthExLink(ctx.wireClient.clio, {
    chainKind:  ChainKind.EVM,
    account,
    privateKey: emPriv,
    ethWallet
  })
  // 6b) Authex link for SOL — signs with the ED25519 key directly.
  await createAuthExLink(ctx.wireClient.clio, {
    chainKind:  ChainKind.SVM,
    account,
    privateKey: solSdkKey
  })

  // 7) regoperator(is_bootstrapped: false). Signed as opreg so the
  //    deposit-path's `bypubkey` lookup resolves back to this
  //    account (the bypubkey index is what the depot uses to map
  //    inbound OPERATOR_ACTION attestations to a WIRE account
  //    name).
  await ctx.wireClient.clio.pushActionAndWait<
    SystemContracts.SysioOpregRegoperatorAction
  >(
    "sysio.opreg",
    "regoperator",
    {
      account,
      type:            SystemContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
      is_bootstrapped: false
    },
    "sysio.opreg@active"
  )

  log.info(
    `[provisionFreshBatchOperator] ${account} provisioned — ETH ${ethWallet.address} (hdIndex=${ethHdIndex}), SOL ${solPublicKey.toBase58()}`
  )

  return {
    account,
    ethWallet,
    ethCompressedPubkey,
    solKeypair,
    solPublicKey
  }
}

// ---------------------------------------------------------------------------
// Fresh batchop daemon spawn
// ---------------------------------------------------------------------------

/**
 * Options for {@link startFreshBatchOperatorDaemon}.
 */
export interface FreshBatchOperatorDaemonOptions {
  /**
   * HTTP port for the daemon's nodeop. Defaults to {@link
   * OperatorProvisioning.DefaultDaemonHttpPort}. Must be free; the
   * harness's default batchOperatorHttp range stops at index 2.
   */
  httpPort?: number
  /**
   * P2P port for the daemon's nodeop. Defaults to {@link
   * OperatorProvisioning.DefaultDaemonP2pPort}.
   */
  p2pPort?: number
  /**
   * Template node id whose `start.cmd` is cloned (genesis,
   * plugin set, outpost-client args). Defaults to `batchop_00`.
   */
  templateNodeId?: string
  /**
   * Timeout (ms) for the daemon's HTTP `get_info` to respond.
   * Defaults to 60 seconds.
   */
  readyTimeoutMs?: number
}

/**
 * Handle returned by {@link startFreshBatchOperatorDaemon}.
 */
export interface FreshBatchOperatorDaemon {
  /** HTTP endpoint URL the daemon listens on. */
  endpointUrl: string
  /** Operating-system pid. */
  pid: number
  /** Internal ProcessManager label (`node_batchop_<account>`). */
  label: string
}

/**
 * Spawn a real `batch_operator_plugin` daemon bound to {@link freshOp}.
 *
 * Why this exists: per [[flow-test-scenario-structure]] the harness
 * substrate only bootstraps `cfg.batchOperatorCount` daemons (default
 * 3 in tests). A test that provisions a fresh non-bootstrapped batch
 * operator and lets it briefly flip ACTIVE will see the depot's
 * `sysio.epoch::advance` / `schbatchgps` enter that operator into the
 * sliding-window `batch_op_groups` (per the preference rule). Without
 * a running relay, the group's sole-member consensus (group_size=1)
 * cannot be reached when the operator's epoch slot arrives — the chain
 * stalls. Spinning up a real daemon for the fresh op gives it a relay
 * so consensus rolls forward through its slot the same way the
 * bootstrapped ops do.
 *
 * Cloning approach: rather than rebuilding the full ~30-arg nodeop
 * command from scratch, this reads the existing
 * `node_batchop_00/start.cmd` (already finalized post-Phase-10a outpost
 * arg injection) and substitutes the account-specific bits. Keeps the
 * helper resilient to future args added to the harness's batchop
 * daemon — anything common stays inherited.
 *
 * @param ctx     Active flow test context (cluster path + ports).
 * @param freshOp The provisioned operator returned by
 *                {@link provisionFreshBatchOperator}.
 * @param options Optional port + template overrides.
 * @returns       Daemon handle with the live HTTP endpoint URL.
 *
 * @example
 *     const freshOp = await provisionFreshBatchOperator(ctx, {
 *       account: "depositor", ethHdIndex: 35
 *     })
 *     await startFreshBatchOperatorDaemon(ctx, freshOp)
 */
export async function startFreshBatchOperatorDaemon(
  ctx:     FlowTestContext,
  freshOp: FreshBatchOperator,
  options: FreshBatchOperatorDaemonOptions = {}
): Promise<FreshBatchOperatorDaemon> {
  const httpPort       = options.httpPort       ?? OperatorProvisioning.DefaultDaemonHttpPort
  const p2pPort        = options.p2pPort        ?? OperatorProvisioning.DefaultDaemonP2pPort
  const templateNodeId = options.templateNodeId ?? OperatorProvisioning.DefaultTemplateNodeId
  const readyTimeoutMs = options.readyTimeoutMs ?? OperatorProvisioning.DefaultDaemonReadyTimeoutMs

  const clusterPath  = ctx.clusterPath
  const templatePath = Path.join(clusterPath, "data", `node_${templateNodeId}`)
  const templateCmd  = Path.join(templatePath, "start.cmd")
  Assert.ok(
    Fs.existsSync(templateCmd),
    `startFreshBatchOperatorDaemon: template start.cmd missing at ${templateCmd}`
  )

  const nodeLabel = `batchop_${freshOp.account}`
  const newNodeDir = Path.join(clusterPath, "data", `node_${nodeLabel}`)
  Fs.mkdirSync(newNodeDir, { recursive: true })
  Fs.copyFileSync(
    Path.join(templatePath, "genesis.json"),
    Path.join(newNodeDir, "genesis.json")
  )

  const tokens = Fs.readFileSync(templateCmd, "utf-8").split(/\s+/).filter(Boolean)
  const binary = tokens[0]
  const args   = tokens.slice(1)

  // The template's account name lives in `--batch-operator-account
  // <name>`. The bootstrapped ops are batchop.a / batchop.b / …; the
  // exact name is whatever ClusterManager generated for the template
  // slot. Find it dynamically so we can rewrite every reference.
  const accountArgIdx = args.indexOf("--batch-operator-account")
  Assert.ok(
    accountArgIdx >= 0 && accountArgIdx + 1 < args.length,
    "startFreshBatchOperatorDaemon: template missing --batch-operator-account"
  )
  const templateAccount = args[accountArgIdx + 1]

  // Build the substituted argument list. Single-pass scan: each entry
  // either survives unchanged or is replaced by a substitution rule.
  const newArgs = args.map((arg, i) => {
    const prev = i > 0 ? args[i - 1] : ""
    // Port + listener substitutions
    if (prev === "--p2p-listen-endpoint")  return `0.0.0.0:${p2pPort}`
    if (prev === "--p2p-server-address")   return `127.0.0.1:${p2pPort}`
    if (prev === "--http-server-address")  return `127.0.0.1:${httpPort}`
    // Directory substitutions — node dir is unique per fresh op.
    if (prev === "--config-dir")  return newNodeDir
    if (prev === "--data-dir")    return newNodeDir
    if (prev === "--genesis-json") return Path.join(newNodeDir, "genesis.json")
    // Account binding
    if (prev === "--batch-operator-account") return freshOp.account
    // Sig-provider name substitutions on the outpost client specs.
    // Template form: <id>,<sig-name>,<rpc-url>[,<chain-id>]
    if (prev === "--outpost-ethereum-client") {
      return arg.replace(`,eth-${templateAccount},`, `,eth-${freshOp.account},`)
    }
    if (prev === "--outpost-solana-client") {
      return arg.replace(`,sol-${templateAccount},`, `,sol-${freshOp.account},`)
    }
    // ETH sig-provider line: replace the whole CSV when the name slot matches.
    // The signature-provider arg is itself a CSV starting with the name slot.
    if (prev === "--signature-provider" && arg.startsWith(`eth-${templateAccount},`)) {
      const ethPriv = freshOp.ethWallet.privateKey
      const ethPubUncompressed =
        "0x" + freshOp.ethWallet.signingKey.publicKey.slice(4)
      return [
        `eth-${freshOp.account}`,
        "ethereum",
        "ethereum",
        ethPubUncompressed,
        `KEY:${ethPriv}`
      ].join(",")
    }
    if (prev === "--signature-provider" && arg.startsWith(`sol-${templateAccount},`)) {
      // WIRE PrivateKey<ED> stores the full 64-byte secretKey (seed
      // + pubkey concat, same shape as `Keypair.secretKey`). Pass it
      // through hex.
      const fullHex = Buffer.from(freshOp.solKeypair.secretKey).toString("hex")
      const solPriv = PrivateKey.regenerate(
        KeyType.ED,
        Bytes.fromString(fullHex, "hex")
      )
      return [
        `sol-${freshOp.account}`,
        "solana",
        "solana",
        freshOp.solPublicKey.toBase58(),
        `KEY:${solPriv.toNativeString()}`
      ].join(",")
    }
    return arg
  })

  log.info(
    `[startFreshBatchOperatorDaemon] launching daemon for ${freshOp.account} on http=127.0.0.1:${httpPort} p2p=:${p2pPort}`
  )

  const endpointUrl = `http://127.0.0.1:${httpPort}`
  const label = `node-${nodeLabel}`

  // First spawn: the daemon's nodeop is a fresh sync target with no
  // local state, so its initial `refresh_outposts` query against
  // `sysio.chains::chains` errors out as "Account Query Exception"
  // (the contract isn't loaded yet). The batch_operator_plugin then
  // schedules ONLY `batch_operator_epoch_tick` — no per-outpost
  // inbound/outbound cron jobs — and never re-evaluates that
  // decision when outposts later become queryable. The bootstrapped
  // batchop daemons sidestep this via their Phase 11d kill-restart
  // cycle; we replicate the cycle here.
  const ProcessMgr = ProcessManager.get()
  const firstHandle = await spawnDaemon(ProcessMgr, label, binary, newArgs, newNodeDir, endpointUrl, readyTimeoutMs)

  // Wait for the daemon's nodeop to sync to producer's head before
  // restarting. See `waitForNodeOpSync` for the rationale —
  // batch_operator_plugin only schedules outpost cron jobs when it
  // reads >=1 outposts from sysio.chains AT STARTUP, so we need the
  // second spawn's startup pass to see a fully-loaded chain state.
  const producerEndpointUrl = `http://127.0.0.1:${ctx.ports.producerHttp[0]}`
  await waitForNodeOpSync(
    endpointUrl,
    producerEndpointUrl,
    OperatorProvisioning.OutpostDiscoveryTimeoutMs
  )

  log.info(
    `[startFreshBatchOperatorDaemon] daemon synced; cycling to (re)schedule outpost cron jobs`
  )
  // Kill via the handle (cleans up pidfile + log tail) and respawn.
  await firstHandle.kill()
  const handle = await spawnDaemon(ProcessMgr, label, binary, newArgs, newNodeDir, endpointUrl, readyTimeoutMs)

  return {
    endpointUrl,
    pid:   handle.pid,
    label
  }
}

/**
 * Spawn the daemon once, returning when its HTTP endpoint responds.
 * Internal helper for the kill-restart cycle in
 * {@link startFreshBatchOperatorDaemon}.
 */
async function spawnDaemon(
  pm:           ProcessManager,
  label:        string,
  binary:       string,
  args:         string[],
  cwd:          string,
  endpointUrl:  string,
  readyTimeoutMs: number
) {
  return pm.spawn({
    label,
    command: binary,
    args,
    cwd,
    verifyCallback: async () => {
      try {
        await waitForEndpoint(`${endpointUrl}/v1/chain/get_info`, {
          label,
          timeoutMs: 1_000
        })
        return true
      } catch {
        return false
      }
    },
    verifyTimeoutMs:  readyTimeoutMs,
    verifyIntervalMs: 1_000
  })
}

/**
 * Wait until the daemon's nodeop has synced to within `lagTolerance`
 * blocks of the producer's head. The batch_operator_plugin's
 * `refresh_outposts` only fires AT STARTUP and when the operator is
 * elected for an epoch — and election requires being already in
 * `batch_op_groups`, which requires ACTIVE status, which requires
 * deposits, which requires the daemon's relay to be online. So we
 * can't wait for "outposts discovered" mid-flight; instead we wait
 * for sync, then the caller kills and respawns the daemon so its
 * second startup pass reads `sysio.chains` and schedules the
 * per-outpost cron jobs at startup time (matching the bootstrapped
 * batchop daemons' Phase-11d kill-restart shape).
 *
 * @param daemonEndpointUrl URL of the daemon's HTTP API.
 * @param producerEndpointUrl URL of the producer node's HTTP API.
 * @param timeoutMs  Deadline; throws if exceeded.
 * @param lagTolerance How many blocks behind the producer is "synced".
 */
async function waitForNodeOpSync(
  daemonEndpointUrl:   string,
  producerEndpointUrl: string,
  timeoutMs:           number,
  lagTolerance:        number = OperatorProvisioning.SyncLagToleranceBlocks
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const [daemonInfo, producerInfo] = await Promise.all([
        fetch(`${daemonEndpointUrl}/v1/chain/get_info`).then(r => r.json() as Promise<{ head_block_num: number }>),
        fetch(`${producerEndpointUrl}/v1/chain/get_info`).then(r => r.json() as Promise<{ head_block_num: number }>)
      ])
      const daemonHead = Number(daemonInfo.head_block_num ?? 0)
      const producerHead = Number(producerInfo.head_block_num ?? 0)
      if (daemonHead > 0 && producerHead - daemonHead <= lagTolerance) {
        log.info(
          `[waitForNodeOpSync] daemon caught up: daemon head=${daemonHead}, producer head=${producerHead}`
        )
        return
      }
    } catch {
      // transient; keep polling
    }
    await new Promise(r => setTimeout(r, 1_000))
  }
  throw new Error(
    `waitForNodeOpSync: daemon at ${daemonEndpointUrl} never caught up to producer at ${producerEndpointUrl} within ${timeoutMs}ms`
  )
}

export namespace OperatorProvisioning {
  /**
   * HTTP port for a fresh-batchop daemon. Picked outside the harness's
   * default `batchOperatorHttp[0..2]` range so it never collides with
   * a bootstrapped daemon. Override via {@link
   * FreshBatchOperatorDaemonOptions.httpPort} if the test needs a
   * specific value.
   */
  export const DefaultDaemonHttpPort = 8895
  /** P2P port matching {@link DefaultDaemonHttpPort}. */
  export const DefaultDaemonP2pPort = 9885
  /** Template node id to clone start.cmd from. */
  export const DefaultTemplateNodeId = "batchop_00"
  /** Default `get_info` ready-wait deadline. */
  export const DefaultDaemonReadyTimeoutMs = 60_000
  /**
   * Maximum wait for the daemon's first-spawn nodeop to sync to
   * within {@link SyncLagToleranceBlocks} of the producer's head.
   * Drives the kill-restart cycle gate in
   * {@link startFreshBatchOperatorDaemon}.
   *
   * The fresh daemon's nodeop replays every block from genesis. With a
   * ~200-block chain at spawn time and 0.5s/block applying-time, sync
   * typically completes in ~60-120s. Allow a healthy margin.
   */
  export const OutpostDiscoveryTimeoutMs = 360_000
  /**
   * How many blocks behind the producer's head the daemon's nodeop
   * can be while still counted as "synced". 5 blocks ≈ 2.5s — small
   * enough that the daemon's second startup will read the same
   * sysio.chains state the bootstrapped daemons see, large enough
   * that the daemon doesn't race the producer's tip forever.
   */
  export const SyncLagToleranceBlocks = 5
}
