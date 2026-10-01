import Assert from "node:assert"
import { execFile } from "node:child_process"
import Fs from "node:fs/promises"
import Path from "node:path"
import { promisify, stripVTControlCharacters } from "node:util"

import { BN } from "@coral-xyz/anchor"
import { ComputeBudgetProgram } from "@solana/web3.js"
import { ChainKind } from "@wireio/opp-typescript-models"
import { PrivateKey, SysioContracts } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { match } from "ts-pattern"
import { isError, Wallet } from "ethers"
import {
  AuthExLinkTool,
  ClusterBuildStep,
  EthereumSyndicationTool,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  WireClient,
  getLogger,
  clearNonceCache,
  matchesProtoEnum,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type StepInput,
  type Report
} from "@wireio/cluster-tool"
import { EmergencyStopScenarioConstants as Constants } from "../EmergencyStopScenarioConstants.js"

const log = getLogger(__filename),
  execFileAsync = promisify(execFile)

/** Runtime Steps each submit one action or execute one read-only script. */
export namespace EmergencyStopSteps {
  /** The scenario's writes that require runtime output values. */
  export enum Action {
    challenge = "challenge",
    valid = "valid",
    claim = "claim",
    transfer = "transfer",
    synd = "synd",
    desyndicate = "desyndicate",
    paySolana = "paySolana",
    replaySolana = "replaySolana",
    linkEthereum = "linkEthereum",
    payEthereum = "payEthereum",
    recreditSolana = "recreditSolana",
    donateSolana = "donateSolana",
    recreditEthereum = "recreditEthereum",
    donateEthereum = "donateEthereum"
  }
  /** Typed operation and optional exact expected rejection. */
  export interface ActionInput extends StepInput {
    readonly kind: "EmergencyStopSteps.ActionInput"
    readonly action: Action
    readonly refusal?: string
  }
  /** Plan one runtime action; an expected refusal is still a separately reported attempt. */
  export function planAction(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    action: Action,
    refusal?: string
  ): ClusterBuildStep<ClusterBuildContext, ActionInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      { kind: "EmergencyStopSteps.ActionInput", action, refusal },
      runAction
    )
  }
  /** Resolve the operation's arguments and submit exactly one transaction. */
  export async function runAction(
    ctx: ClusterBuildContext,
    input: ActionInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    try {
      await match(input.action)
        .with(Action.challenge, () =>
          Steps.contracts.sysio.synd.runChallenge(
            ctx,
            {
              kind: "SyndContractSteps.ChallengeInput",
              data: {
                challenger: SyndicationScenario.Bonder,
                chain_code: SyndicationScenario.Chain,
                token_code: SyndicationScenario.Token,
                epoch_index: ctx.outputs.assert(Constants.HeldEpoch)
              }
            },
            signal
          )
        )
        .with(Action.valid, () =>
          Steps.contracts.sysio.bond.runRslvvalid(
            ctx,
            {
              kind: "BondContractSteps.RslvvalidInput",
              data: { request_id: ctx.outputs.assert(Constants.HeldRequest) }
            },
            signal
          )
        )
        .with(Action.claim, () =>
          Steps.contracts.sysio.bond.runClaim(
            ctx,
            {
              kind: "BondContractSteps.ClaimInput",
              data: {
                request_id: ctx.outputs.assert(Constants.HeldRequest),
                account: SyndicationScenario.Bonder
              },
              signer: SyndicationScenario.Bonder
            },
            signal
          )
        )
        .with(Action.transfer, () =>
          ctx.wire
            .getSysioContract(SysioContracts.SysioContractName.liq)
            .actions.transfer.invoke(
              {
                from: SyndicationScenario.Bonder,
                to: Constants.User.account,
                quantity: SyndicationScenario.quantity(Constants.Deficit),
                memo: "frozen transfer refusal"
              },
              {
                authorization: WireClient.activeAuthorization(
                  SyndicationScenario.Bonder
                )
              }
            )
        )
        .with(Action.synd, () =>
          SolanaLiqSyndicationTool.runSynd(
            ctx,
            {
              kind: "SolanaLiqSyndicationTool.SyndInput",
              userName: Constants.User.keypairName,
              amount: Constants.ProbeAmount
            },
            signal
          )
        )
        .with(Action.desyndicate, () =>
          Steps.contracts.sysio.synd.runDesyndicate(
            ctx,
            {
              kind: "SyndContractSteps.DesyndicateInput",
              data: {
                holder: Constants.User.account,
                quantity: SyndicationScenario.quantity(Constants.Payout)
              }
            },
            signal
          )
        )
        .with(Action.paySolana, () =>
          SolanaLiqSyndicationTool.runPayPendingDesyndication(
            ctx,
            {
              kind: "SolanaLiqSyndicationTool.PayPendingDesyndicationInput",
              callerName: Constants.User.keypairName,
              requestId: ctx.outputs.assert(Constants.Pending).requestId
            },
            signal
          )
        )
        .with(Action.replaySolana, () => replaySolana(ctx))
        .with(Action.linkEthereum, () => {
          const privateKey = PrivateKey.from(
            Steps.registry.readMockSyndicationBonder(ctx).ethereum.privateKey
          )
          return AuthExLinkTool.createLink(ctx.wire, {
            chainKind: ChainKind.EVM,
            account: SyndicationScenario.Bonder,
            privateKey,
            ethereumWallet: new Wallet(privateKey.toNativeString())
          })
        })
        .with(Action.payEthereum, () =>
          EthereumSyndicationTool.runPayPendingDesyndication(
            ctx,
            {
              kind: "EthereumSyndicationTool.PayPendingDesyndicationInput",
              ethereumHdIndex: Constants.EthereumDonor,
              requestId: ctx.outputs.assert(Constants.EthereumRequest)
            },
            signal
          )
        )
        .with(Action.recreditSolana, Action.recreditEthereum, () =>
          Steps.contracts.sysio.liq.runRecredit(
            ctx,
            {
              kind: "LiqContractSteps.RecreditInput",
              data: {
                holder: Constants.User.account,
                quantity: SyndicationScenario.quantity(
                  ctx.outputs.assert(Constants.Shortfall)
                ).replace(
                  SyndicationScenario.Token,
                  input.action === Action.recreditEthereum
                    ? Constants.EthereumToken
                    : SyndicationScenario.Token
                )
              }
            },
            signal
          )
        )
        .with(Action.donateSolana, () =>
          SolanaLiqSyndicationTool.runDonateToPool(
            ctx,
            {
              kind: "SolanaLiqSyndicationTool.DonateToPoolInput",
              donorName: Constants.User.keypairName,
              amount: ctx.outputs.assert(Constants.Shortfall)
            },
            signal
          )
        )
        .with(Action.donateEthereum, () =>
          EthereumSyndicationTool.runDonateToPool(
            ctx,
            {
              kind: "EthereumSyndicationTool.DonateToPoolInput",
              ethereumHdIndex: Constants.EthereumDonor,
              amount:
                ctx.outputs.assert(Constants.Shortfall) *
                Constants.EthereumScale
            },
            signal
          )
        )
        .exhaustive()
    } catch (error) {
      log.info(`Emergency stop action ${input.action}: ${String(error)}`)
      if (
        input.action === Action.payEthereum &&
        isError(error, "CALL_EXCEPTION") &&
        error.action === "estimateGas" &&
        error.transaction.from
      ) {
        // Estimation failed before broadcast; release the reserved nonce before another write.
        clearNonceCache(error.transaction.from)
        log.info(
          `Cleared unconsumed Ethereum nonce for ${error.transaction.from}`
        )
      }
      const reason =
        input.action === Action.payEthereum &&
        isError(error, "CALL_EXCEPTION") &&
        error.data
          ? EthereumSyndicationTool.loadSyndicationPool(
              ctx,
              ctx.ethereum.provider
            ).interface.parseError(error.data)?.name
          : String(error)
      const refused =
        input.refusal &&
        (input.action === Action.payEthereum
          ? reason === input.refusal
          : /^0x[0-9a-f]+$/i.test(input.refusal)
            ? new RegExp(`${input.refusal}(?![0-9a-f])`, "i").test(reason)
            : reason?.includes(input.refusal))
      if (!refused)
        throw new NestedError(
          `Unexpected emergency-stop action refusal: ${input.action}`,
          { cause: error }
        )
      return
    }
    Assert.ok(
      !input.refusal,
      `${input.action} unexpectedly succeeded; expected ${input.refusal}`
    )
  }
  /** Retry the closed account on chain using the original manifest, bypassing no program gate. */
  async function replaySolana(ctx: ClusterBuildContext): Promise<void> {
    const record = ctx.outputs.assert(Constants.Pending),
      caller = SolanaFundingTool.loadKeypair(
        ctx.config.dataPath,
        Constants.User.keypairName
      ),
      pdas = SolanaLiqSyndicationTool.deriveUserPdas(
        ctx.config.solanaPath,
        record.user
      ),
      program = SolanaLiqSyndicationTool.loadLiqsolProgram(ctx, caller),
      transaction = await program.methods
        .payPendingDesyndication(new BN(record.requestId.toString()))
        .accountsStrict(
          SolanaLiqSyndicationTool.payPendingDesyndicationAccounts(
            pdas,
            caller.publicKey,
            record.address,
            record.rentPayer
          )
        )
        .remainingAccounts(
          SolanaLiqSyndicationTool.payPendingDesyndicationManifest(pdas)
        )
        .preInstructions([
          ComputeBudgetProgram.requestHeapFrame({
            bytes: SolanaLiqSyndicationTool.DispatchHeapFrameBytes
          }),
          ComputeBudgetProgram.setComputeUnitLimit({
            units: SolanaLiqSyndicationTool.SettlementComputeUnitLimit
          })
        ])
        .transaction()
    // The second call must fail program account validation during preflight, not a harness read.
    await ctx.solana.connection.sendTransaction(transaction, [caller], {
      skipPreflight: false
    })
  }
  /** Allowed script commands are strictly read-only. */
  export enum ScriptCommand {
    status = "status",
    pending = "pending"
  }
  /** Read-only command captured in the Report. */
  export interface ScriptInput extends StepInput {
    readonly kind: "EmergencyStopSteps.ScriptInput"
    readonly command: ScriptCommand
  }
  /** Run the packaged emergency script against this cluster during the freeze. */
  export function planScript(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    command: ScriptCommand
  ): ClusterBuildStep<ClusterBuildContext, ScriptInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      { kind: "EmergencyStopSteps.ScriptInput", command },
      runScript
    )
  }
  /** Explicit RPC and wallet avoid Anchor.toml's remote provider override. */
  export async function runScript(
    ctx: ClusterBuildContext,
    input: ScriptInput,
    signal: AbortSignal
  ): Promise<void> {
    const wallet = SolanaFundingTool.keypairFile(
        ctx.config.dataPath,
        SolanaFundingTool.PanicKeypairName
      ),
      result = await execFileAsync(
        "npx",
        ["ts-node", "scripts/wire-config/emergencyStop.ts", input.command],
        {
          cwd: ctx.config.solanaPath,
          env: {
            ...process.env,
            ANCHOR_PROVIDER_URL: ctx.solana.rpcUrl,
            ANCHOR_WALLET: wallet
          },
          signal,
          timeout: SyndicationScenario.VerifyOptions.timeoutMs
        }
      ).catch(error => {
        log.error("Read-only emergency script failed", error)
        throw new NestedError("Emergency script failed", { cause: error })
      })
    log.info(
      `emergencyStop.ts ${input.command}\n${result.stdout}${result.stderr}`
    )
    await Fs.writeFile(
      Path.join(ctx.config.clusterPath, `emergency-stop-${input.command}.txt`),
      result.stdout + result.stderr
    )
    assertScriptOutput(
      input.command,
      result.stdout,
      ctx.solana.rpcUrl,
      input.command === ScriptCommand.pending
        ? ctx.outputs.assert(Constants.Pending)
        : undefined
    )
  }
  /** Identify the exact admitted syndication probe, including its token, kind and epoch. */
  export function assertProbeMismatchIdentity(
    row: SysioContracts.SysioSyndMismatchRowType,
    epoch: number
  ): void {
    Assert.strictEqual(row.token_code, SyndicationScenario.Token)
    Assert.ok(
      matchesProtoEnum(
        row.kind,
        SysioContracts.SysioSyndItemKind,
        SysioContracts.SysioSyndItemKind.SYNDICATION
      )
    )
    Assert.strictEqual(BigInt(row.epoch_index), BigInt(epoch))
  }
  /** A repaired outpost must never report a shortfall at or beyond its recovery boundary. */
  export function assertRecoveryMismatches(
    rows: SysioContracts.SysioSyndMismatchRowType[],
    sequence: bigint
  ): void {
    Assert.ok(
      rows.every(
        row =>
          row.chain_code !== SyndicationScenario.Chain ||
          BigInt(row.sequence) < sequence
      ),
      "post-repair Solana message recorded a custody mismatch"
    )
  }
  /** Validate the packaged command's target and the freeze or stored-payout evidence. */
  export function assertScriptOutput(
    command: ScriptCommand,
    stdout: string,
    rpc: string,
    record?: SolanaLiqSyndicationTool.PendingPayoutRecord
  ): void {
    stdout = stripVTControlCharacters(stdout)
    Assert.ok(stdout.includes(rpc), "script targeted wrong RPC")
    if (command === ScriptCommand.status) Assert.match(stdout, /frozen: true/)
    else {
      Assert.ok(record, "missing expected pending payout")
      const fields = stdout
        .split("\n")
        .map(line => line.trim().split(/\s+/))
        .find(values => values.includes(`request_id=${record.requestId}`))
      Assert.ok(fields, "script did not list the stored request")
      Assert.ok(fields.includes(`amount=${record.amount}`))
      Assert.ok(fields.includes("reason=outpostFrozen"))
      Assert.ok(fields.includes(`pda=${record.address.toBase58()}`))
    }
  }
}
